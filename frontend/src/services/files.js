import * as db from "/db.js";
import { api } from "/sync.js";
import { entrySignature, periodEntries, today, validateEntry } from "/model.js";

export function download(blob, name) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export function chooseFile(accept, callback, fail) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.addEventListener(
    "change",
    () => {
      if (input.files?.[0])
        Promise.resolve(callback(input.files[0])).catch(fail);
    },
    { once: true },
  );
  input.click();
}
const fileJSON = (value) =>
  JSON.stringify(value, (key, item) =>
    ["_pending", "_issue"].includes(key) ? undefined : item,
  );
async function fileRequest(path, options) {
  if (!navigator.onLine)
    throw Error(
      "Для XLSX нужен доступ к серверу. Локальная резервная копия JSON работает без сети.",
    );
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...options.headers, "X-Finance-Data-Version": "4" },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw Error(
      "Сервер обработки XLSX недоступен. Повторите после подключения к сети.",
    );
  }
  if (!response.ok) {
    let message = "Не удалось обработать XLSX";
    try {
      message = (await response.json()).error || message;
    } catch {}
    throw Error(message);
  }
  return response;
}
export async function exportFile(period, account) {
  const local = await db.load();
  const state = new Blob(
    [
      fileJSON({
        ...local.state,
        entries: periodEntries(local.state.entries, period, account),
      }),
    ],
    { type: "application/json" },
  );
  const compressed =
    state.size > 1 << 20 && typeof CompressionStream !== "undefined";
  const body = compressed
    ? await new Response(
        state.stream().pipeThrough(new CompressionStream("gzip")),
      ).blob()
    : state;
  const response = await fileRequest("/api/local-files/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(compressed ? { "Content-Encoding": "gzip" } : {}),
    },
    body,
  });
  download(await response.blob(), "finance-" + today() + ".xlsx");
}
export async function previewImport(file) {
  if (file.size > 10 * 1024 * 1024) throw Error("Файл больше 10 MiB");
  const local = await db.load(),
    { bookId, userId, connected } = local.settings;
  if (connected && local.pending.length)
    throw Error(
      "Перед импортом отправьте изменения и разрешите конфликты синхронизации.",
    );
  let response;
  if (connected)
    response = await fileRequest(`/api/books/${bookId}/import`, {
      method: "POST",
      body: file,
      headers: { "X-Finance-User": userId },
    });
  else {
    const form = new FormData();
    form.set("file", file);
    form.set(
      "state",
      fileJSON({
        accounts: local.state.accounts,
        categories: local.state.categories,
      }),
    );
    response = await fileRequest("/api/local-files/preview", {
      method: "POST",
      body: form,
    });
  }
  const proposal = await response.json();
  if (!connected && !/^[a-f0-9]{64}$/.test(proposal.fileHash))
    throw Error("Некорректный ответ сервера импорта");
  if (!connected) {
    const counts = new Map();
    for (const entry of local.state.entries.filter((e) => !e.deleted)) {
      const key = entrySignature(entry);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    proposal.duplicates = [];
    for (const entry of proposal.entries) {
      const key = entrySignature(entry),
        count = counts.get(key) || 0;
      if (count) {
        proposal.duplicates.push(entry.id);
        counts.set(key, count - 1);
      }
    }
  }
  const settings = await db.meta("settings");
  if (
    settings.bookId !== bookId ||
    settings.userId !== userId ||
    settings.connected !== connected
  )
    throw Error("Книга или пользователь изменились. Откройте файл заново.");
  const catalogs = {
    accounts: [...local.state.accounts],
    categories: [...local.state.categories],
  };
  for (const command of proposal.commands)
    if (command.entity !== "entry")
      catalogs[command.entity === "account" ? "accounts" : "categories"].push(
        command.data,
      );
  return {
    local,
    bookId,
    connected,
    proposal,
    catalogs,
    expectedState: JSON.stringify(local.state),
    already:
      proposal.applied ||
      (!connected &&
        !!(await db.meta(`local-import:${bookId}:${proposal.fileHash}`))),
  };
}
export async function applyImport(preview, duplicates) {
  const { bookId, connected, proposal, catalogs, local, expectedState } =
    preview;
  const userId = local.settings.userId;
  if (proposal.errors.length) throw Error("Сначала исправьте ошибки файла");
  const settings = await db.meta("settings");
  if (
    settings.bookId !== bookId ||
    settings.userId !== userId ||
    settings.connected !== connected
  )
    throw Error("Книга или пользователь изменились. Откройте файл заново.");
  if (connected)
    return api(
      `/api/books/${bookId}/import/${proposal.id}`,
      { includeDuplicates: duplicates },
      undefined,
      userId,
    );
  const included = new Set(duplicates);
  const commands = proposal.commands.filter(
    (c) =>
      c.entity !== "entry" ||
      !proposal.duplicates.includes(c.data.id) ||
      included.has(c.data.id),
  );
  const entries = commands.filter((c) => c.entity === "entry");
  const target = {
    ...catalogs,
    entries: [...local.state.entries, ...entries.map((c) => c.data)],
  };
  if (
    target.accounts.length > 100 ||
    target.categories.length > 500 ||
    target.entries.length > 50000
  )
    throw Error("Лимит книги: 100 счетов, 500 категорий, 50 000 операций");
  for (const entry of entries) validateEntry(entry.data, target);
  return db.saveMany(
    commands.map(({ entity, data }) => ({ entity, data })),
    bookId,
    {
      hash: proposal.fileHash,
      expectedState,
      count: entries.length,
      expectedUser: userId ?? null,
    },
  );
}
