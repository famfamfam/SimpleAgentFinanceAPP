import { test, expect } from "@playwright/test";
import { extname } from "node:path";
import { clientAsset } from "./helpers/client-assets.js";

test.use({ serviceWorkers: "block" });

async function serveAssets(route) {
  const path = new URL(route.request().url()).pathname;
  const file = path === "/" ? "index.html" : path.slice(1);
  try {
    const body = await clientAsset(file);
    const contentType = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream";
    await route.fulfill({ body, contentType });
  } catch { await route.fulfill({ status: 404 }); }
}

test("switching language preserves an existing book and persists after reload", async ({ page }) => {
  await page.route("http://localhost:19878/**", serveAssets);
  await page.goto("http://localhost:19878/");
  await page.waitForFunction(() => window.__financeReady);
  const before = await page.evaluate(async () => (await import("/db.js")).backup());
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByLabel("Язык", { exact: true }).selectOption("en");
  await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("link", { name: "Assistant", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tell us what you spent" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message to assistant" })).toBeVisible();
  await page.getByRole("button", { name: "Attach receipt photo" }).click();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take photo" })).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.__financeReady);
  await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
  const after = await page.evaluate(async () => (await import("/db.js")).backup());
  expect(after.base).toEqual(before.base);
  expect(after.outbox).toEqual(before.outbox);
});

test("new English books keep their default names and creation language after switching to Russian", async ({ page }) => {
  await page.route("http://localhost:19878/**", serveAssets);
  await page.addInitScript(() => localStorage.setItem("finance-language", "en"));
  await page.goto("http://localhost:19878/");
  await page.waitForFunction(() => window.__financeReady);
  const before = await page.evaluate(async () => (await import("/db.js")).load());
  expect(before.settings.initialLanguage).toBe("en");
  expect(before.settings.bookName).toBe("Personal book");
  expect(before.state.accounts[0].name).toBe("Main");
  expect(before.state.categories[0].name).toBe("Groceries");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Language", { exact: true }).selectOption("ru");
  const after = await page.evaluate(async () => (await import("/db.js")).load());
  expect(after.state).toEqual(before.state);
  expect(after.settings.initialLanguage).toBe("en");
});

test("English accounting flow saves expense and cross-currency transfer without changing currencies", async ({ page }) => {
  await page.route("http://localhost:19878/**", serveAssets);
  await page.addInitScript(() => localStorage.setItem("finance-language", "en"));
  await page.clock.setFixedTime(new Date("2026-11-01T12:00:00Z"));
  await page.goto("http://localhost:19878/");
  await page.waitForFunction(() => window.__financeReady);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "New account", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Travel USD");
  await page.getByLabel("Account currency").selectOption("USD");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("25.50");
  await page.getByRole("button", { name: "Groceries", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Transfer", exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("9000");
  await page.getByLabel("To", { exact: true }).selectOption({ label: "Travel USD · USD" });
  await page.getByLabel("Received, USD").fill("100");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("dialog")).toHaveCount(0);
  const state = await page.evaluate(async () => (await (await import("/db.js")).load()).state);
  expect(state.entries).toHaveLength(2);
  expect(state.entries.find(e => e.kind === "expense")).toMatchObject({ amount: "25.50", currency: "RUB" });
  expect(state.entries.find(e => e.kind === "transfer")).toMatchObject({ amount: "9000.00", currency: "RUB", toAmount: "100.00", toCurrency: "USD" });
  await page.getByRole("link", { name: "Entries", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(2);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Entry type", { exact: true }).selectOption("transfer");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await expect(page.locator(".entry")).toContainText("Travel USD");
});

test("an open settings dialog updates its language across tabs", async ({ page, context }) => {
  await context.route("http://localhost:19878/**", serveAssets);
  await page.goto("http://localhost:19878/");
  await page.waitForFunction(() => window.__financeReady);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Локальные архивы книг" }).click();
  await expect(page.getByRole("dialog")).toContainText("Архивов пока нет.");
  const other = await context.newPage();
  await other.goto("http://localhost:19878/");
  await other.waitForFunction(() => window.__financeReady);
  await other.getByRole("link", { name: "Настройки", exact: true }).click();
  await other.getByLabel("Язык", { exact: true }).selectOption("en");
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Local archives");
  await expect(page.getByRole("dialog")).toContainText("No archives yet.");
});

test("switching language keeps the values of an open registration form", async ({ page, context }) => {
  await context.route("http://localhost:19878/**", serveAssets);
  await page.route("**/api/me", route => route.fulfill({ status: 401, json: { error: "Нужен вход" } }));
  await page.route("**/api/register", route => route.fulfill({ status: 400, json: { error: "Неверный пароль доступа" } }));
  await page.goto("http://localhost:19878/");
  await page.waitForFunction(() => window.__financeReady);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Подключить синхронизацию" }).click();
  await page.getByLabel("Как вас называть?").fill("Test user");
  await page.getByLabel("Пароль доступа").fill("test-password");
  const other = await context.newPage();
  await other.goto("http://localhost:19878/");
  await other.waitForFunction(() => window.__financeReady);
  await other.getByRole("link", { name: "Настройки", exact: true }).click();
  await other.getByLabel("Язык", { exact: true }).selectOption("en");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("Connect to server");
  await expect(dialog.getByLabel("What should we call you?")).toHaveValue("Test user");
  await expect(dialog.getByLabel("Access password")).toHaveValue("test-password");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Incorrect access password");
  await other.getByLabel("Language", { exact: true }).selectOption("ru");
  await expect(dialog.getByRole("alert")).toHaveText("Неверный пароль доступа");
  await expect(dialog.getByLabel("Как вас называть?")).toHaveValue("Test user");
});

test("period validation error changes language without losing the selected dates", async ({ page, context }) => {
  await context.route("http://localhost:19878/**", serveAssets);
  await page.goto("http://localhost:19878/");
  await page.waitForFunction(() => window.__financeReady);
  await page.getByRole("button", { name: "Выбрать период", exact: true }).click();
  await page.locator("#period-mode").selectOption("range");
  await page.locator("#period-from").fill("2026-06-02");
  await page.locator("#period-to").fill("2026-06-01");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Начало периода должно быть не позже окончания");
  const other = await context.newPage();
  await other.goto("http://localhost:19878/");
  await other.waitForFunction(() => window.__financeReady);
  await other.getByRole("link", { name: "Настройки", exact: true }).click();
  await other.getByLabel("Язык", { exact: true }).selectOption("en");
  await expect(page.getByRole("alert")).toHaveText("The period start must not be after the end");
  await expect(page.locator("#period-from")).toHaveValue("2026-06-02");
  await other.getByLabel("Language", { exact: true }).selectOption("ru");
  await expect(page.getByRole("alert")).toHaveText("Начало периода должно быть не позже окончания");
});

test("changing language in another tab preserves an open entry form", async ({ page, context }) => {
  await context.route("http://localhost:19878/**", serveAssets);
  await page.goto("http://localhost:19878/");
  await page.waitForFunction(() => window.__financeReady);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByLabel("Сумма", { exact: true }).fill("125,50");
  const other = await context.newPage();
  await other.goto("http://localhost:19878/");
  await other.waitForFunction(() => window.__financeReady);
  await other.getByRole("link", { name: "Настройки", exact: true }).click();
  await other.getByLabel("Язык", { exact: true }).selectOption("en");
  await expect(page.getByRole("dialog").getByLabel("Amount", { exact: true })).toHaveValue("125,50");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Save" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Продукты" })).toBeVisible();
});
