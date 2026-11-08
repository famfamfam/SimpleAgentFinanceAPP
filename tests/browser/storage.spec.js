import { test, expect } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";
test.use({ serviceWorkers: "block" });
test("assistant draft survives background refresh and reopening", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  await page.getByRole("link", { name: "Помощник", exact: true }).click();
  await page.locator("#ai-text").fill("Вчера продукты 850");
  await page.waitForTimeout(400);
  await page.evaluate(() => window.dispatchEvent(new Event("finance-updated")));
  await expect(page.locator("#ai-text")).toHaveValue("Вчера продукты 850");
  await page.reload();
  await expect(page.locator("#ai-text")).toHaveValue("Вчера продукты 850");
});
test("a failed local batch leaves no partial financial edits", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    const local = await db.load();
    try {
      await db.saveMany(
        [
          {
            entity: "account",
            data: {
              id: crypto.randomUUID(),
              name: "Should roll back",
              opening: "0.00",
            },
          },
          { entity: "unknown", data: { id: "bad" } },
        ],
        local.settings.bookId,
      );
    } catch {}
    return (await db.load()).pending.length;
  });
  expect(result).toBe(0);
});
test("an old response and old editor cannot alter a newly selected book", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js"),
      { initialState } = await import("/model.js");
    const previous = await db.meta("settings"),
      next = { ...previous, bookId: crypto.randomUUID(), bookName: "Next" };
    await db.switchBook(next, { state: initialState(), revision: 1 });
    const state = initialState();
    state.accounts[0].name = "Wrong book";
    await db.accept({ state, revision: 99, results: [] }, previous.bookId);
    let rejected = false;
    try {
      await db.save("account", state.accounts[0], previous.bookId);
    } catch {
      rejected = true;
    }
    const batch = await db.prepareBatch(previous.bookId);
    return {
      rejected,
      batch: batch.length,
      name: (await db.load()).state.accounts[0].name,
    };
  });
  expect(result).toEqual({ rejected: true, batch: 0, name: "Основной" });
});
test("editing while a command is in flight preserves both immutable payload and next version", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    const local = await db.load(),
      book = local.settings.bookId;
    const entry = {
      id: crypto.randomUUID(),
      kind: "expense",
      amount: "1.00",
      accountId: local.state.accounts[0].id,
      categoryId: local.state.categories[0].id,
      date: "2026-10-29",
      time: "",
      note: "First",
      tags: "",
      version: 0,
      deleted: false,
    };
    await db.save("entry", entry, book);
    const batch = await db.prepareBatch(book);
    await db.save("entry", { ...entry, note: "Second" }, book);
    const pending = (await db.load()).pending;
    await db.accept(
      {
        state: { ...local.state, entries: [{ ...entry, version: 2 }] },
        revision: 2,
        results: [{ id: batch[0].id, status: "ok", version: 2 }],
      },
      book,
    );
    const next = await db.prepareBatch(book);
    return {
      first: pending[0].data.note,
      second: pending[1].data.note,
      nextNote: next[0].data.note,
      nextBase: next[0].base,
      differentID: next[0].id !== batch[0].id,
    };
  });
  expect(result).toEqual({
    first: "First",
    second: "Second",
    nextNote: "Second",
    nextBase: 2,
    differentID: true,
  });
});

test("offline account archive follows entries using its pending creation", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    const local = await db.load(),
      book = local.settings.bookId;
    const account = {
      id: crypto.randomUUID(),
      name: "Наличные",
      opening: "0.00",
      version: 0,
      deleted: false,
    };
    await db.save("account", account, book);
    await db.save(
      "entry",
      {
        id: crypto.randomUUID(),
        accountId: account.id,
        categoryId: local.state.categories[0].id,
        kind: "expense",
        amount: "1.00",
        date: "2026-10-29",
        time: "",
        note: "Before archive",
        tags: "",
        version: 0,
        deleted: false,
      },
      book,
    );
    await db.save("account", { ...account, deleted: true }, book);
    const pending = (await db.load()).pending;
    const batch = await db.prepareBatch(book);
    return {
      entities: pending.map((x) => x.entity),
      firstDeleted: batch[0].data.deleted,
      second: batch[1].entity,
      archiveDepends: pending[2].depends === pending[0].id,
    };
  });
  expect(result).toEqual({
    entities: ["account", "entry", "account"],
    firstDeleted: false,
    second: "entry",
    archiveDepends: true,
  });
});

test("concurrent confirmations of the same local file commit only one import", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js"),
      local = await db.load();
    const imported = {
      hash: "a".repeat(64),
      expectedState: JSON.stringify(local.state),
      count: 1,
    };
    const data = {
      kind: "expense",
      amount: "1.00",
      date: "2026-10-29",
      accountId: local.state.accounts[0].id,
      categoryId: local.state.categories[0].id,
      note: "",
      tags: "",
      version: 0,
      deleted: false,
    };
    const results = await Promise.all([
      db.saveMany(
        [{ entity: "entry", data: { ...data, id: crypto.randomUUID() } }],
        local.settings.bookId,
        imported,
      ),
      db.saveMany(
        [{ entity: "entry", data: { ...data, id: crypto.randomUUID() } }],
        local.settings.bookId,
        imported,
      ),
    ]);
    return {
      entries: (await db.load()).state.entries.length,
      alreadyApplied: results.filter((r) => r.alreadyApplied).length,
      marker: Boolean(
        await db.meta(
          "local-import:" + local.settings.bookId + ":" + imported.hash,
        ),
      ),
    };
  });
  expect(result).toEqual({ entries: 1, alreadyApplied: 1, marker: true });
});

test("a downloaded JSON backup above 30 MiB restores through the UI", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async () => {
    const db = await import("/db.js"), backup = await db.backup();
    const state = backup.base[0].data;
    state.entries = Array.from({ length: 8000 }, () => ({
      id: crypto.randomUUID(), kind: "expense", amount: "1.00", date: "2026-10-29",
      accountId: state.accounts[0].id, categoryId: state.categories[0].id,
      note: "x".repeat(4096), tags: "", version: 1, deleted: false,
    }));
    await db.restore(backup);
  });
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать локальную резервную копию", exact: true }).click();
  const file = await downloaded, path = await file.path();
  expect((await stat(path)).size).toBeGreaterThan(30 * 1024 * 1024);
  await page.evaluate(async () => {
    const db = await import("/db.js"), backup = await db.backup();
    backup.base[0].data.entries = [];
    await db.restore(backup);
  });
  page.once("dialog", dialog => dialog.accept());
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Восстановить локальную копию", exact: true }).click();
  await (await chooser).setFiles(path);
  await expect(page.locator("#toast")).toHaveText("Локальная копия восстановлена", { timeout: 30000 });
  const restored = await page.evaluate(async () => {
    const local = await (await import("/db.js")).load();
    return { entries: local.state.entries.length, note: local.state.entries.at(-1).note.length };
  });
  expect(restored).toEqual({ entries: 8000, note: 4096 });
});

test("large XLSX exports send the complete local book compressed", async ({ page, context }) => {
  test.setTimeout(60000);
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const catalogs = await page.evaluate(async () => {
    const db = await import("/db.js"), backup = await db.backup(), state = backup.base[0].data;
    state.entries = Array.from({ length: 3000 }, () => ({
      id: crypto.randomUUID(), kind: "expense", amount: "1.00", date: "2026-10-29",
      accountId: state.accounts[0].id, categoryId: state.categories[0].id,
      note: "x".repeat(4096), tags: "", version: 1, deleted: false,
    }));
    await db.restore(backup);
    return { accounts: state.accounts, categories: state.categories };
  });
  await page.getByRole("button", { name:"Выбрать период", exact:true }).click();
  await page.getByLabel("Период", { exact:true }).selectOption("all");
  await page.getByRole("button", { name:"Применить", exact:true }).click();
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  const request = page.waitForRequest("**/api/local-files/export");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Выгрузить XLSX", exact: true }).click();
  expect((await request).headers()["content-encoding"]).toBe("gzip");
  const file = await downloaded;
  const response = await context.request.post("/api/local-files/preview", {
    multipart: {
      state: JSON.stringify(catalogs),
      file: { name: "large.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await readFile(await file.path()) },
    },
  });
  expect(response.ok()).toBeTruthy();
  const imported = await response.json();
  expect(imported.errors).toEqual([]);
  expect(imported.entries.length).toBe(3000);
  expect(imported.entries.at(-1).note.length).toBe(4096);
});

test("oversized and damaged JSON backups leave the current data intact", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js"), original = await db.backup();
    let oversized = false, damaged = false;
    try {
      await db.readBackup({ size: 128 * 1024 * 1024 + 1, text: () => { throw Error("Must not read oversized input"); } });
    } catch (error) { oversized = error.message === "Копия больше 128 MiB"; }
    const invalid = structuredClone(original);
    invalid.base[0].data.accounts[0].opening = "NaN";
    try { db.backupFile(invalid); } catch { damaged = true; }
    try { await db.restore(invalid); } catch {}
    const after = await db.backup();
    after.createdAt = original.createdAt;
    return { oversized, damaged, unchanged: JSON.stringify(after) === JSON.stringify(original) };
  });
  expect(result).toEqual({ oversized: true, damaged: true, unchanged: true });
});
