import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.use({ serviceWorkers: "block" });

test("connected import shows every period even while an older sync is in flight", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const local = await page.evaluate(async () => (await import("/db.js")).load());
  const registered = await context.request.post("/api/register", {
    data: { nickname: "Import test", password: process.env.TEST_REGISTRATION_PASSWORD || "ci-only-registration-password" },
  });
  expect(registered.ok()).toBeTruthy();
  const { user } = await registered.json(), book = local.settings.bookId;
  expect((await context.request.post("/api/books", { data: { id: book, name: "Import test" } })).ok()).toBeTruthy();
  await page.evaluate(async user => {
    const db = await import("/db.js");
    await db.setMeta("settings", { ...await db.meta("settings"), connected: true, userId: user.id });
  }, user);
  await page.reload();
  await page.waitForFunction(() => window.__financeReady);
  const entries = ["2025-03-24", "2025-04-01", "2025-04-02"].map(date => ({
    id: randomUUID(), kind: "expense", amount: "1.00", date,
    accountId: local.state.accounts[0].id, categoryId: local.state.categories[0].id,
    note: "Historical import", tags: "", version: 0, deleted: false,
  }));
  const file = await context.request.post("/api/local-files/export", { data: { ...local.state, entries } });
  expect(file.ok()).toBeTruthy();
  await page.getByRole("link", { name: "Операции", exact: true }).click();
  await page.getByRole("button", { name: "Фильтры", exact: true }).click();
  await page.getByLabel("Тип операции").selectOption("income");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page.getByRole("searchbox").fill("No matching records");
  const upload = async () => {
    await page.getByRole("link", { name: "Настройки", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Импортировать XLSX", exact: true }).click();
    await (await chooser).setFiles({ name: "history.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await file.body() });
  };
  await upload();
  await expect(page.getByRole("heading", { name: "Проверка импорта", exact: true })).toBeVisible();
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { started = resolve; });
  let hold = true;
  await page.route(`**/api/books/${book}/sync`, async route => {
    if (hold && route.request().method() === "GET") {
      hold = false;
      const response = await route.fetch();
      started();
      await blocked;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.evaluate(() => { void import("/sync.js").then(module => module.sync().catch(() => {})); });
    await received;
    await page.getByRole("button", { name: "Импортировать", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Операции", exact: true })).toBeVisible();
    await expect(page.locator(".entry")).toHaveCount(3);
    await expect(page.getByRole("searchbox")).toHaveValue("");
    await expect(page.locator(".filter-count")).toHaveCount(0);
  } finally { release(); }
  await expect.poll(() => page.evaluate(async () => (await (await import("/db.js")).load()).state.entries.length)).toBe(3);
  await page.getByRole("button", { name: "Выбрать период", exact: true }).click();
  await page.getByLabel("Период", { exact:true }).selectOption("month");
  await page.getByRole("button", { name:"Применить", exact:true }).click();
  await expect(page.locator(".entry")).toHaveCount(0);
  await page.getByRole("button", { name: "Выбрать период", exact: true }).click();
  await page.getByLabel("Период", { exact:true }).selectOption("all");
  await page.getByRole("button", { name:"Применить", exact:true }).click();
  await expect(page.locator(".entry")).toHaveCount(3);
  await upload();
  await expect(page.locator("#toast")).toHaveText("Этот файл уже импортирован");
  await expect(page.locator(".entry")).toHaveCount(3);
});
