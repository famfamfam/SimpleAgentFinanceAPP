import * as db from "/db.js";
import * as chat from "/chat-db.js";
import { api, sync, syncChat } from "/sync.js";
import { derivedID, today, clock } from "/model.js";

const listeners = new Set();
const activities = new Set();
let running,
  timer,
  inFlight = "",
  installed = false;
const same = (a, b) => a?.bookId === b?.bookId && a?.userId === b?.userId;
const owns = (item, settings) =>
  item.bookId === settings.bookId &&
  (!item.ownerId || item.ownerId === settings.userId);
const enabled = (settings) =>
  navigator.onLine &&
  settings?.connected &&
  !settings.revoked &&
  !settings.authRequired;
const callbacks = () => [...listeners].at(-1);
export const assistantInFlight = () => inFlight;
export const assistantActivity = (reader) => {
  activities.add(reader);
  return () => activities.delete(reader);
};
export function assistantChanged() {
  window.dispatchEvent(new Event("finance-assistant-updated"));
}
export async function assertAssistantScope(settings) {
  const latest = await db.meta("settings");
  if (!same(settings, latest))
    throw Error("Книга или пользователь изменились. Обновите экран");
  return latest;
}
export async function editQueued(settings, id, patch) {
  await db.transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta"),
      latest = (await db.request(store.get("settings")))?.value;
    if (!same(settings, latest))
      throw Error("Книга или пользователь изменились");
    const queue = (await db.request(store.get("ai-queue")))?.value || [];
    store.put({
      id: "ai-queue",
      value: queue.flatMap((item) =>
        owns(item, settings) && item.input.id === id
          ? patch
            ? [{ ...item, ...patch }]
            : []
          : [item],
      ),
    });
  });
  assistantChanged();
  wakeAssistantWorker();
}
export async function ensureAssistant(settings, id) {
  await assertAssistantScope(settings);
  const scope = chat.scopeOf(settings);
  let saved = ((await db.meta("ai-results")) || []).find(
    (x) => x.id === id && owns(x, settings) && (!x.scope || x.scope === scope),
  );
  if (saved) {
    if (saved.cancelled) throw Error("Задача больше не доступна");
    return saved;
  }
  const m = await chat.message(settings, await derivedID(id, 100));
  if (!m?.result || m.deleted || m.status === "cancelled")
    throw Error("Задача больше не доступна");
  saved = {
    id,
    taskId: m.taskId,
    bookId: settings.bookId,
    ownerId: settings.userId,
    scope,
    contextMode: "explicit",
    manual: true,
    result: m.result,
    saved: m.status === "applied",
    savedIDs: m.appliedIDs || [],
  };
  await db.transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    if (!same(settings, (await db.request(store.get("settings")))?.value))
      throw Error("Книга или пользователь изменились");
    const all = (await db.request(store.get("ai-results")))?.value || [];
    if (!all.some((x) => x.id === id && x.scope === scope))
      store.put({ id: "ai-results", value: [...all, saved] });
  });
  return saved;
}
export async function updateAssistant(settings, saved, patch) {
  await db.transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    if (!same(settings, (await db.request(store.get("settings")))?.value))
      throw Error("Книга или пользователь изменились");
    const all = (await db.request(store.get("ai-results")))?.value || [];
    store.put({
      id: "ai-results",
      value: all.map((x) =>
        x.id === saved.id &&
        owns(x, settings) &&
        x.scope === saved.scope &&
        !x.cancelled &&
        !x.saved
          ? { ...x, ...patch }
          : x,
      ),
    });
  });
  assistantChanged();
}
export async function finishAssistant(
  saved,
  entries,
  categories = [],
  options = {},
) {
  const settings = await db.meta("settings");
  if (!owns(saved, settings)) throw Error("Книга или пользователь изменились");
  const result = await db.saveAssistant(
    saved.id,
    saved.bookId,
    entries.map((e) => ({ ...e, note: e.note || "", tags: e.tags || "" })),
    categories,
  );
  await db.transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    if (!same(settings, (await db.request(store.get("settings")))?.value))
      return;
    const draft = await chat.draftValue(store, settings, "entry");
    if (saved.entryDraftId && draft?.draft.id === saved.entryDraftId)
      await chat.putDraft(store, settings, "entry", null);
  });
  assistantChanged();
  const handlers = options.handlers || callbacks();
  await handlers?.refresh?.();
  if (same(settings, await db.meta("settings"))) {
    const ids = result.ids.filter((id) => entries.some((e) => e.id === id));
    const background = () =>
      location.hash !== "#assistant" ||
      !!document.querySelector("dialog[open]") ||
      [...activities].some((read) => read(saved));
    if (ids.length)
      await handlers?.revealEntries?.(
        ids,
        saved.bookId,
        options.foreground ? false : background,
      );
    else
      handlers?.toast?.(
        categories.length
          ? "Категория создана"
          : "Использована существующая категория",
      );
  }
  if (navigator.onLine)
    sync()
      .then(() => syncChat())
      .catch((error) => callbacks()?.fail?.(error));
  return result;
}
export async function sendAssistant(
  settings,
  { text, attachment, quotes = [], entryReturn, accountId },
) {
  await assertAssistantScope(settings);
  if (!settings.userId)
    throw Error(
      "Подключите синхронизацию в настройках, чтобы пользоваться помощником",
    );
  if (!text.trim() && !attachment)
    throw Error("Напишите сообщение или запишите голос");
  if (text.length > 4096) throw Error("Сообщение длиннее 4096 символов");
  chat.checkQuotes(quotes);
  if (entryReturn) {
    const draft = await chat.readDraft(settings, "entry");
    if (draft?.draft.id !== entryReturn.draft.id)
      throw Error("Черновик операции изменился. Обновите экран");
    entryReturn = draft;
  }
  const context = await db.meta("ai-context:" + settings.bookId),
    active =
      context?.pending && context.userId === settings.userId ? context : null;
  const head = await chat.state(settings),
    clickedAt = new Date();
  const input = {
    id: crypto.randomUUID(),
    text: text.trim(),
    taskId: active?.taskId || crypto.randomUUID(),
    mode: "auto",
    contextMode: "explicit",
    sentAt: clickedAt.toISOString(),
    chatEpoch: head.epoch,
    date: active?.date || entryReturn?.draft.date || today(),
    time: active?.time ?? entryReturn?.draft.time ?? clock(),
    accountId: active?.accountId || entryReturn?.draft.accountId || accountId,
    ...(active ? { pendingTaskId: active.taskId } : {}),
    ...(quotes.length ? { quoteIds: quotes.map((m) => m.id) } : {}),
    ...(attachment?.image ? { image: attachment.image } : {}),
    ...(attachment?.audio ? { audio: attachment.audio } : {}),
  };
  await chat.enqueue(
    {
      bookId: settings.bookId,
      ownerId: settings.userId,
      input,
      receipt: active?.receipt,
      createdAt: clickedAt.getTime(),
      entryDraftId: entryReturn?.draft.id,
    },
    attachment,
  );
  assistantChanged();
  wakeAssistantWorker();
  return input;
}
export async function continueAssistant(settings, message) {
  if (
    !message?.result ||
    message.deleted ||
    ["cancelled", "applied"].includes(message.status)
  )
    throw Error("Эта задача уже завершена");
  const saved = await ensureAssistant(settings, message.replyTo),
    original = await chat.message(settings, message.replyTo),
    date = new Date(original?.createdAt || message.createdAt),
    first = message.result.entries?.[0];
  await db.transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    if (!same(settings, (await db.request(store.get("settings")))?.value))
      throw Error("Книга или пользователь изменились");
    store.put({
      id: "ai-context:" + settings.bookId,
      value: {
        taskId: message.taskId,
        requestId: saved.id,
        userId: settings.userId,
        pending: true,
        updatedAt: Date.now(),
        previous: [],
        date:
          first?.date ||
          `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        time:
          first?.time ||
          `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
        accountId: first?.accountId,
        receipt: !!message.result.receipt,
      },
    });
    store.put({
      id: "ai-active:" + chat.scopeOf(settings),
      value: message.taskId,
    });
  });
  assistantChanged();
}
async function autoApply(saved) {
  if (
    saved.manual ||
    saved.cancelled ||
    saved.saved ||
    saved.result.action !== "add" ||
    saved.result.receipt ||
    saved.result.category
  )
    return;
  try {
    await finishAssistant(saved, saved.result.entries);
  } catch (error) {
    if (!owns(saved, await db.meta("settings"))) return;
    await db.reviewAssistant(
      saved.id,
      saved.bookId,
      "Проверьте перед сохранением: " + error.message,
    );
    callbacks()?.fail?.(error);
    assistantChanged();
  }
}
async function processQueue() {
  let settings = await db.meta("settings");
  if (!enabled(settings)) return;
  await sync({ wait: true });
  await syncChat();
  settings = await db.meta("settings");
  if (!enabled(settings) || (await chat.pendingDeletion(settings))) return;
  for (const saved of (await db.meta("ai-results")) || []) {
    if (!listeners.size || !same(settings, await db.meta("settings"))) return;
    if (owns(saved, settings)) await autoApply(saved);
  }
  for (;;) {
    if (
      !listeners.size ||
      !same(settings, await db.meta("settings")) ||
      !enabled(settings) ||
      (await chat.pendingDeletion(settings))
    )
      break;
    const item = ((await db.meta("ai-queue")) || []).find(
      (x) => owns(x, settings) && !x.paused && !(x.retryAt > Date.now()),
    );
    if (!item) break;
    inFlight = item.input.id;
    assistantChanged();
    const progress = setTimeout(() => {
      if (listeners.size) syncChat().catch(() => {});
    }, 500);
    try {
      const response = await api(
        `/api/books/${item.bookId}/assistant`,
        item.input.contextMode === "explicit"
          ? await chat.inputFor(item)
          : item.input,
        undefined,
        item.ownerId || settings.userId,
      );
      if (item.input.image || item.receipt) {
        response.receipt = true;
        if (!response.category) response.action = "review";
      }
      // A completed request may be persisted only while its original owner/book is still active.
      if (!same(settings, await db.meta("settings"))) break;
      const results =
        item.input.contextMode === "explicit"
          ? await chat.complete(item, response)
          : await db.completeAI(item, response);
      if (item.input.contextMode !== "explicit")
        await chat.migrateLegacyAudio();
      const saved = results.find(
        (x) => x.id === item.input.id && owns(x, settings),
      );
      if (saved) await autoApply(saved);
      syncChat().catch(() => {});
    } catch (error) {
      if (!same(settings, await db.meta("settings"))) break;
      if (error.status === 410 && item.input.contextMode === "explicit") {
        await chat.cancelTask(settings, item.input.taskId);
        await editQueued(settings, item.input.id, null);
      } else {
        const attempts = (item.attempts || 0) + 1;
        await editQueued(settings, item.input.id, {
          attempts,
          paused:
            [400, 401, 403, 413, 422].includes(error.status) ||
            attempts >= 3 ||
            error.retryAfter >= 3600,
          retryAt:
            Date.now() +
            Math.max(
              30000 * 2 ** (attempts - 1),
              (error.retryAfter || 0) * 1000,
            ),
          error: error.message || "Не удалось отправить запрос",
        });
        break;
      }
    } finally {
      clearTimeout(progress);
      inFlight = "";
      assistantChanged();
    }
    await callbacks()?.refresh?.();
  }
}
async function runWorker() {
  if (!listeners.size || running) return;
  clearTimeout(timer);
  running = (async () => {
    if (navigator.locks?.request)
      await navigator.locks.request(
        "finance-react-assistant",
        { ifAvailable: true },
        (lock) => (lock ? processQueue() : undefined),
      );
    else await processQueue();
  })().catch((error) => callbacks()?.fail?.(error));
  try {
    await running;
  } finally {
    running = null;
    if (listeners.size) {
      const settings = await db.meta("settings");
      if (enabled(settings)) {
        const queue = (await db.meta("ai-queue")) || [];
        const times = queue
          .filter((x) => owns(x, settings) && !x.paused)
          .map((x) => Math.max(1000, (x.retryAt || 0) - Date.now()));
        timer = setTimeout(runWorker, Math.min(30000, ...times));
      }
    }
  }
}
export function wakeAssistantWorker() {
  if (listeners.size && !running) {
    clearTimeout(timer);
    timer = setTimeout(runWorker, 0);
  }
}
const onVisible = () => {
  if (!document.hidden) wakeAssistantWorker();
};
export function startAssistantWorker(handlers) {
  listeners.add(handlers);
  if (!installed) {
    installed = true;
    window.addEventListener("online", wakeAssistantWorker);
    window.addEventListener("finance-updated", wakeAssistantWorker);
    window.addEventListener("finance-assistant-wake", wakeAssistantWorker);
    document.addEventListener("visibilitychange", onVisible);
    chat
      .migrateLegacyAudio()
      .then(assistantChanged)
      .catch((error) => callbacks()?.fail?.(error));
  }
  wakeAssistantWorker();
  return () => {
    listeners.delete(handlers);
    if (!listeners.size) {
      installed = false;
      clearTimeout(timer);
      window.removeEventListener("online", wakeAssistantWorker);
      window.removeEventListener("finance-updated", wakeAssistantWorker);
      window.removeEventListener("finance-assistant-wake", wakeAssistantWorker);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

export async function legacyMessages(settings, results, queue) {
  const rows = [];
  for (const x of results.filter(
    (x) => owns(x, settings) && x.contextMode !== "explicit",
  )) {
    const createdAt = new Date(x.createdAt || Date.now()).toISOString(),
      taskId = x.taskId || x.id;
    if (!x.deletedUser)
      rows.push({
        id: x.id,
        key: x.legacyMediaKey,
        taskId,
        role: "user",
        text: x.prompt || "",
        audio: !!x.audio || !!x.legacyMediaKey,
        legacyAudio: x.audio,
        legacyMediaKey: x.legacyMediaKey,
        cachedAudio: !!x.legacyMediaKey,
        transcript: x.result.transcript || "",
        createdAt,
        legacy: true,
        source: x,
      });
    if (!x.deletedReply)
      rows.push({
        id: await derivedID(x.id, 100),
        taskId,
        role: "assistant",
        text: x.saved ? "Операции добавлены" : x.result.text,
        result: x.result,
        replyTo: x.id,
        createdAt,
        legacy: true,
        source: x,
        status: x.saved
          ? "applied"
          : x.cancelled || x.importedScope
            ? "cancelled"
            : "legacy",
      });
  }
  for (const x of queue.filter(
    (x) => owns(x, settings) && x.input.contextMode !== "explicit",
  ))
    rows.push({
      id: x.input.id,
      taskId: x.input.taskId || x.input.id,
      role: "user",
      text: x.input.text,
      audio: !!x.input.audio,
      legacyAudio: x.input.audio,
      createdAt: new Date(x.createdAt || Date.now()).toISOString(),
      legacy: true,
      queued: true,
    });
  return rows.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      (a.taskId === b.taskId
        ? a.role === "user"
          ? -1
          : 1
        : a.id.localeCompare(b.id)),
  );
}
export async function deleteLegacy(settings, rows, ids, clear) {
  await assertAssistantScope(settings);
  const selected = new Set(ids),
    chosen = rows.filter((m) => clear || selected.has(m.id));
  await db.transaction(["meta", "media"], async (tx) => {
    const store = tx.objectStore("meta");
    if (!same(settings, (await db.request(store.get("settings")))?.value))
      throw Error("Книга или пользователь изменились");
    const results = (await db.request(store.get("ai-results")))?.value || [];
    const next = results
      .map((x) => {
        if (!owns(x, settings) || x.contextMode === "explicit") return x;
        const user = chosen.some((m) => m.id === x.id),
          reply = chosen.some((m) => m.replyTo === x.id);
        if (!user && !reply) return x;
        if (user && x.legacyMediaKey)
          tx.objectStore("media").delete(x.legacyMediaKey);
        return {
          ...x,
          ...(user
            ? {
                deletedUser: true,
                prompt: "",
                audio: undefined,
                legacyMediaKey: undefined,
              }
            : {}),
          ...(reply ? { deletedReply: true } : {}),
          manual: true,
          cancelled: !x.saved,
          result: !x.saved ? { ...x.result, action: "answer" } : x.result,
        };
      })
      .filter((x) => !x.deletedUser || !x.deletedReply);
    store.put({ id: "ai-results", value: next });
    const queue = (await db.request(store.get("ai-queue")))?.value || [];
    store.put({
      id: "ai-queue",
      value: queue.filter(
        (x) =>
          !owns(x, settings) ||
          x.input.contextMode === "explicit" ||
          (!clear && !selected.has(x.input.id)),
      ),
    });
  });
  assistantChanged();
}
export async function importLegacy(settings, rows) {
  await assertAssistantScope(settings);
  if (!settings.connected || !navigator.onLine)
    throw Error("Для переноса переписки подключитесь к серверу");
  const scope = chat.scopeOf(settings),
    head = await chat.state(settings),
    recent = rows.filter(
      (m) => Date.now() - Date.parse(m.createdAt) < 90 * 86400000 && !m.queued,
    );
  const wire = recent.map((m) => ({
    id: m.id,
    taskId: m.taskId,
    role: m.role,
    text: m.text,
    transcript: m.transcript || "",
    createdAt: m.createdAt,
    audio: m.audio || false,
    ...(m.result
      ? { result: { ...m.result, transcript: undefined }, replyTo: m.replyTo }
      : {}),
  }));
  for (let i = 0; i < wire.length; i += 50) {
    await assertAssistantScope(settings);
    await api(
      `/api/books/${settings.bookId}/chat/import`,
      { epoch: head.epoch, messages: wire.slice(i, i + 50) },
      undefined,
      settings.userId,
    );
  }
  await chat.accept(
    settings,
    await api(
      `/api/books/${settings.bookId}/chat`,
      undefined,
      undefined,
      settings.userId,
    ),
  );
  const uploaded = new Set();
  for (const m of recent)
    if (
      (m.legacyAudio || m.legacyMediaKey) &&
      Date.now() - Date.parse(m.createdAt) < 30 * 86400000
    ) {
      await assertAssistantScope(settings);
      const blob = m.legacyAudio
        ? chat.base64Blob(m.legacyAudio)
        : (
            await chat.media(
              { userId: "legacy", bookId: settings.bookId },
              m.id,
            )
          )?.blob;
      if (!blob) continue;
      const response = await fetch(
        `/api/books/${settings.bookId}/chat/media/${m.id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "audio/wav",
            "X-Finance-User": settings.userId,
          },
          body: blob,
          credentials: "same-origin",
          signal: AbortSignal.timeout(20000),
        },
      );
      if (response.status === 410) continue;
      if (!response.ok)
        throw Error(
          "Текст перенесён, но аудио пока не удалось загрузить. Повторите перенос позже",
        );
      await chat.cacheMedia(settings, m.id, blob, true);
      uploaded.add(m.id);
    }
  await db.transaction(["meta", "media"], async (tx) => {
    const store = tx.objectStore("meta"),
      all = (await db.request(store.get("ai-results")))?.value || [];
    if (!same(settings, (await db.request(store.get("settings")))?.value))
      throw Error("Книга или пользователь изменились");
    store.put({
      id: "ai-results",
      value: all.map((x) => {
        if (!owns(x, settings) || x.contextMode === "explicit") return x;
        if (uploaded.has(x.id) && x.legacyMediaKey)
          tx.objectStore("media").delete(x.legacyMediaKey);
        return {
          ...x,
          manual: true,
          importedScope: scope,
          ...(uploaded.has(x.id)
            ? { audio: undefined, legacyMediaKey: undefined }
            : {}),
        };
      }),
    });
  });
  assistantChanged();
  syncChat().catch(() => {});
}
