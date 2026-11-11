import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await page.route(/\/(db|chat-db|sync|model|icons|release|i18n|en|en-screens|en-forms)\.js$/, async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ contentType: "text/javascript", body: await readFile(`backend/web${path}`) });
  });
});

test("cross-currency transfer uses both amounts and reports separate totals", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  await context.setOffline(true);
  await page.evaluate(async () => {
    const db = await import("/db.js"), local = await db.load();
    await db.save("account", { ...local.state.accounts[0], opening: "10000.00" }, local.settings.bookId);
    window.dispatchEvent(new Event("finance-updated"));
  });
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Счета", exact: true }).click();
  await page.getByRole("button", { name: "Новый счет", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Доллары");
  await page.getByLabel("Валюта счета").selectOption("USD");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Счета", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("link", { name: "Обзор", exact: true }).click();
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("button", { name: "Перевод", exact: true }).click();
  await page.getByLabel("Сумма", { exact: true }).fill("9000");
  await page.getByLabel("Куда", { exact: true }).selectOption({ label: "Доллары · USD" });
  await page.getByLabel("Получено, USD").fill("100");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  const result = await page.evaluate(async () => {
    const db = await import("/db.js"), model = await import("/model.js"), local = await db.load();
    const result = model.summarizeByCurrency(local.state, local.state.entries);
    return { balances: Object.fromEntries(local.state.accounts.map(a => [a.currency || "RUB", result.balances[a.id]])), entry: local.state.entries[0], totals: result.totals };
  });
  expect(result.balances).toEqual({ RUB: 100000, USD: 10000 });
  expect(result.entry).toMatchObject({ amount: "9000.00", currency: "RUB", toAmount: "100.00", toCurrency: "USD" });
  expect(result.totals.RUB.expense).toBe(0);
  expect(result.totals.USD.income).toBe(0);
  await expect(page.locator(".entry-sum")).toContainText("USD");
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Счета", exact: true }).click();
  await expect(page.locator("[data-catalog-id]").filter({ hasText: "Доллары" })).toContainText("100 USD");
  await expect(page.locator("[data-catalog-id]").filter({ hasText: "Основной" })).toContainText("1 000 ₽");

  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("link", { name: "Обзор", exact: true }).click();
  await page.getByLabel("Счет обзора", { exact: true }).selectOption({ label: "Доллары · USD" });
  await page.getByLabel("Счет обзора", { exact: true }).selectOption("");
});

test("account currency cannot be changed after creation", async ({ page, context }) => {
  await page.goto("/"); await page.waitForFunction(() => window.__financeReady); await context.setOffline(true);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Счета", exact: true }).click();
  await page.getByRole("button", { name: "Изменить счет Основной" }).click();
  await expect(page.getByLabel("Валюта счета")).toHaveValue("RUB");
  await expect(page.getByLabel("Валюта счета")).toBeDisabled();
});
