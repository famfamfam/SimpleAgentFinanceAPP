import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { extname } from "node:path";
import { clientAsset } from "./helpers/client-assets.js";

test("offline reload retains English and can switch language without losing the book", async ({ page }) => {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      const data = await clientAsset(path === "/" ? "index.html" : path.slice(1));
      response.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" }[extname(path)] || (path === "/" ? "text/html" : "application/octet-stream"));
      response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__financeReady);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller && window.__financeReady);
    const before = await page.evaluate(async () => (await import("/db.js")).backup());
    await page.getByRole("link", { name: "Настройки", exact: true }).click();
    await page.getByLabel("Язык", { exact: true }).selectOption("en");
    // WebKit's setOffline navigation emulation is broken; stop the origin instead.
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await page.reload();
    await page.waitForFunction(() => window.__financeReady);
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByLabel("Language", { exact: true }).selectOption("ru");
    await expect(page.getByRole("link", { name: "Обзор", exact: true })).toBeVisible();
    const after = await page.evaluate(async () => (await import("/db.js")).backup());
    expect(after.base).toEqual(before.base);
    expect(after.outbox).toEqual(before.outbox);
  } finally {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
