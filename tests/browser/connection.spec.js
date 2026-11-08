import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });

test("a late forbidden response cannot revoke the newly selected book", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  await page.waitForTimeout(180);
  let entered;
  const started = new Promise(resolve => entered = resolve);
  let release;
  const gate = new Promise(resolve => release = resolve);
  await page.route("**/api/books/*/sync", async route => {
    entered(); await gate;
    await route.fulfill({ status: 403, json: { error: "Old book denied" } });
  });
  await page.evaluate(async () => {
    const db = await import("/db.js"), settings = await db.meta("settings");
    await db.setMeta("settings", { ...settings, connected: true, userId: "old-user" });
    window.staleSync = (await import("/sync.js")).sync().catch(() => {});
  });
  await started;
  const next = await page.evaluate(async () => {
    const db = await import("/db.js"), settings = await db.meta("settings");
    settings.bookId = crypto.randomUUID(); settings.userId = "new-user";
    await db.switchBook(settings, { state: (await import("/model.js")).initialState(), revision: 1 });
    return settings.bookId;
  });
  release();
  await page.evaluate(() => window.staleSync);
  const settings = await page.evaluate(async () => (await import("/db.js")).meta("settings"));
  expect(settings.bookId).toBe(next);
  expect(settings.revoked).not.toBe(true);
});

test("same-user key recovery keeps unsent entries and the current shared book", async ({ page }) => {
  let currentBook = "";
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") await route.fulfill({ json: { user: { id: "same-user", nickname: "Test" }, books: [{ id: "other-book", name: "Other" }, { id: currentBook, name: "Current" }] } });
    else if (path.endsWith("/sync")) await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    else if (path === "/api/recover") await route.fulfill({ json: { ok: true } });
    else await route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  currentBook = await page.evaluate(async () => {
    const db = await import("/db.js"), local = await db.load();
    await db.setMeta("settings", { ...local.settings, userId: "same-user", connected: true, authRequired: true });
    await db.save("entry", { id: crypto.randomUUID(), kind: "expense", amount: "12.34", accountId: local.state.accounts[0].id, categoryId: local.state.categories[0].id, date: "2026-10-30", note: "Must stay queued", tags: "", version: 0, deleted: false }, local.settings.bookId);
    window.dispatchEvent(new Event("finance-updated"));
    return local.settings.bookId;
  });
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Войти по личному ключу", exact: true }).click();
  await page.locator("[name=key]").fill("test-key");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  const after = await page.evaluate(async () => (await import("/db.js")).load());
  expect(after.settings.bookId).toBe(currentBook);
  expect(after.settings.authRequired).toBe(false);
  expect(after.pending).toHaveLength(1);
  expect(after.state.entries[0].note).toBe("Must stay queued");
});

test("foreign connected backup is rejected before existing data is replaced", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js"), before = await db.load(), backup = await db.backup();
    backup.origin = "https://another-server.invalid";
    const settings = backup.meta.find(x => x.id === "settings");
    settings.value.connected = true;
    settings.value.bookId = crypto.randomUUID();
    let rejected = false;
    try { await db.restore(backup); } catch { rejected = true; }
    const after = await db.load();
    return { rejected, preserved: after.settings.bookId === before.settings.bookId && JSON.stringify(after.state) === JSON.stringify(before.state) };
  });
  expect(result).toEqual({ rejected: true, preserved: true });
});

test("malformed backups leave the original book intact", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js"), before = JSON.stringify(await db.load());
    const mutations = [
      copy => copy.base[0].data.accounts[0].id = '<img src=x>',
      copy => copy.meta.push({ ...copy.meta.find(x => x.id === "settings") }),
      copy => copy.meta.push({ id: "ai-queue", value: [{ input: {} }] }),
    ];
    let rejected = 0;
    for (const mutate of mutations) {
      const copy = await db.backup(); mutate(copy);
      try { await db.restore(copy); } catch { rejected++; }
      if (JSON.stringify(await db.load()) !== before) throw Error("Existing data changed");
    }
    await db.restore(await db.backup());
    return rejected;
  });
  expect(result).toBe(3);
});
