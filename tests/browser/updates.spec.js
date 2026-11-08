import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { clientAsset } from './helpers/client-assets.js';
import { extname } from "node:path";

test("PWA upgrade preserves pending edits, drafts and another tab's open form", async ({ page, context }) => {
  let release = "one", broken = false;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    try {
      if (path.includes("..") || path.startsWith("/api/") || (broken && path === "/icon-180.png")) throw Error();
      const file = path === "/" ? "index.html" : path.slice(1);
      const content = await clientAsset(file, release);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" }[extname(file)] || "application/octet-stream");
      response.end(content);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(origin);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => window.__financeReady && navigator.serviceWorker.controller);
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    await page.getByLabel("Сумма", { exact: true }).fill("123.45");
    await page.getByRole("button", { name: "Продукты", exact: true }).click();
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.locator('#modal')).not.toBeVisible();
    const before = await page.evaluate(async () => (await import("/db.js")).load());
    const other = await context.newPage();
    await other.goto(origin);
    await other.getByRole("button", { name: "Добавить", exact: true }).click();
    await other.getByLabel("Сумма", { exact: true }).fill("222");
    await other.evaluate(async () => (await navigator.serviceWorker.ready).update());
    // A partial download must leave the installed version usable.
    release = "broken";
    broken = true;
    await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
    await expect.poll(() => page.evaluate(async () => (await caches.has("finance-broken")) && !(await navigator.serviceWorker.ready).installing)).toBe(true);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).waiting)).toBeNull();
    expect(await page.evaluate(() => caches.has("finance-one"))).toBeTruthy();
    broken = false;
    release = "two";
    await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return (await caches.has("finance-two")) && !registration.installing && registration.waiting?.state === "installed";
    })).toBe(true);
    await expect(page.locator("#app-update")).toBeVisible();
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    await page.getByLabel("Сумма", { exact: true }).fill("777");
    await page.locator("#app-update button").evaluate(button => button.click());
    await expect(page.getByLabel("Сумма", { exact: true })).toHaveValue("777");
    await expect(page.locator("#toast")).toContainText("Сначала сохраните");
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.getByRole("link", { name: "Помощник", exact: true }).click();
    await page.locator("#ai-text").fill("Сохранить черновик при обновлении");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.getByRole("button", { name: "Обновить", exact: true }).click(),
    ]);
    await page.waitForFunction(() => window.__financeReady);
    await expect(page.locator("#ai-text")).toHaveValue("Сохранить черновик при обновлении");
    expect(await page.evaluate(() => caches.keys())).toContain("finance-two");
    const after = await page.evaluate(async () => (await import("/db.js")).load());
    expect(after.state).toEqual(before.state);
    expect(after.pending).toEqual(before.pending);
    expect(after.settings.bookId).toEqual(before.settings.bookId);
    await expect(other.getByLabel("Сумма", { exact: true })).toHaveValue("222");
    await other.getByRole("button", { name: "Кафе", exact: true }).click();
    await other.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(other.locator("#modal")).not.toBeVisible();
    await other.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await page.reload();
    await page.waitForFunction(() => window.__financeReady);
    expect((await page.evaluate(async () => (await import("/db.js")).load())).state.entries).toHaveLength(2);
  } finally {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

test("local database v1 upgrades without losing queued financial changes", async ({ page }) => {
  await page.goto("/icon.svg");
  const seeded = await page.evaluate(async () => {
    const { initialState } = await import("/model.js");
    const state = initialState();
    const settings = { bookId: crypto.randomUUID(), bookName: "Legacy", connected: false, revision: 3 };
    const entry = { id: crypto.randomUUID(), kind: "expense", amount: "42.50", date: "2026-10-29", time: "00:00", accountId: state.accounts[0].id, categoryId: state.categories[0].id, note: "Unsent", tags: "", version: 0, deleted: false };
    const command = { id: crypto.randomUUID(), entity: "entry", data: entry, order: 1, status: "pending", base: 0, depends: "" };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("finance-v1", 1);
      request.onupgradeneeded = () => { for (const name of ["meta", "base", "outbox"]) request.result.createObjectStore(name, { keyPath: "id" }); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(["meta", "base", "outbox"], "readwrite");
        tx.objectStore("meta").put({ id: "settings", value: settings });
        for (const entity of ["account", "category"]) for (const data of state[entity === "account" ? "accounts" : "categories"]) tx.objectStore("base").put({ id: entity + ":" + data.id, entity, data });
        tx.objectStore("outbox").put(command);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => reject(tx.error);
      };
    });
    return { bookId: settings.bookId, command, entry };
  });
  const dialogs = [];
  page.on("dialog", async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  expect(dialogs).toEqual([
    "Перед обновлением данных сохраните формы и закройте старые окна приложения. Продолжить?",
  ]);
  const current = await page.evaluate(async () => (await import("/db.js")).load());
  expect(current.settings.bookId).toBe(seeded.bookId);
  expect(current.state.entries[0]).toMatchObject(seeded.entry);
  expect(current.pending).toEqual([seeded.command]);
});
