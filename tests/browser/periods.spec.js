import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });

async function choosePeriod(page, mode, from, to) {
  await page.getByRole("button", { name: "Выбрать период", exact: true }).click();
  await page.getByLabel("Период", { exact: true }).selectOption(mode);
  if (from) await page.getByLabel("С", { exact: true }).fill(from);
  if (to) await page.getByLabel("По", { exact: true }).fill(to);
}

test("overview shortcuts switch periods and open custom dates directly",async({page})=>{
  await page.goto("/");await page.waitForFunction(()=>window.__financeReady);
  for(const label of ["День","Неделя","Год","Месяц"]) {
    const button=page.getByRole("button",{name:label,exact:true});await button.click();await expect(button).toHaveAttribute("aria-pressed","true");
  }
  await page.getByRole("button",{name:"Период",exact:true}).click();
  await expect(page.getByLabel("Период",{exact:true})).toHaveValue("range");
  await expect(page.getByLabel("С",{exact:true})).toBeVisible();
});
test("period export includes both kinds, transfers and pending local data", async ({ page }) => {
  await page.goto("/"); await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async () => {
    const db = await import("/db.js"), b = await db.backup(), state = b.base[0].data;
    const expense = { id: crypto.randomUUID(), kind: "expense", amount: "10.00", date: "2026-01-01", accountId: state.accounts[0].id, categoryId: state.categories[0].id, note: "Jan expense", tags: "", version: 0, deleted: false };
    state.entries = [expense, { ...expense, id: crypto.randomUUID(), kind: "income", categoryId: state.categories[8].id, date: "2026-01-31" }, { ...expense, id: crypto.randomUUID(), date: "2026-02-01" }];
    await db.restore(b); window.dispatchEvent(new Event("finance-updated"));
    const second = { ...state.accounts[0], id: crypto.randomUUID(), name: "Второй" };
    await db.save("account", second, b.meta.find(x => x.id === "settings").value.bookId);
    await db.save("entry", { ...expense, id: crypto.randomUUID(), kind: "transfer", categoryId: "", toAccountId: second.id }, b.meta.find(x => x.id === "settings").value.bookId);
    window.dispatchEvent(new Event("finance-updated"));
  });
  await expect(page.locator(".hero")).toHaveCount(0);
  await choosePeriod(page, "range", "2026-01-01", "2026-01-31");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page.getByRole("button", { name: "Доходы", exact: true }).click();
  await expect(page.getByRole("img", { name: /Доходы по категориям/ })).toBeVisible();
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url).includes("/api/local-files/export")) window.exportedState = JSON.parse(await options.body.text());
      return fetch(url, options);
    };
  });
  await page.route("**/api/local-files/export", route => {
    return route.fulfill({ contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: "fixture" });
  });
  await choosePeriod(page, "range", "2026-01-01", "2026-01-31");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Выгрузить XLSX", exact: true }).click(); await download;
  expect(await page.evaluate(() => window.exportedState.entries.map(e => e.kind).sort())).toEqual(["expense", "income", "transfer"]);
  await expect(page.locator("dialog")).toHaveCount(0); // пока модал открыт, страница inert и change до React не доходит
  await page.getByLabel("Счет обзора", { exact: true }).selectOption({label:"Второй"});
  await choosePeriod(page, "range", "2026-01-01", "2026-01-31");
  const scopedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name:"Выгрузить XLSX", exact:true }).click(); await scopedDownload;
  expect(await page.evaluate(() => window.exportedState.entries.map(e=>e.kind))).toEqual(["transfer"]);
  await expect(page.locator("dialog")).toHaveCount(0); // тот же race: ждём закрытия модала второго экспорта
  await page.getByLabel("Счет обзора", { exact:true }).selectOption("");
  await page.getByRole("link", { name: "Операции", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(3);
  await page.reload(); await page.waitForFunction(() => window.__financeReady);
  await page.getByRole("button", { name: "Выбрать период", exact: true }).click();
  await expect(page.getByLabel("Период", { exact: true })).toHaveValue("month");
});

test("saving an older operation opens its page and highlights it", async ({ page }) => {
  await page.goto("/"); await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async () => {
    const db = await import("/db.js"), model = await import("/model.js"), b = await db.backup(), state = b.base[0].data;
    state.entries = Array.from({ length: 205 }, () => ({ id: crypto.randomUUID(), kind: "expense", amount: "1.00", date: model.today(), time: "23:59", accountId: state.accounts[0].id, categoryId: state.categories[0].id, note: "Existing", tags: "", version: 1, deleted: false }));
    await db.restore(b); window.dispatchEvent(new Event("finance-updated"));
  });
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("textbox", { name: "Сумма", exact: true }).fill("2");
  await page.getByRole("button", { name: "Продукты", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".entry.just-added")).toBeVisible();
  await expect(page.locator(".pagination")).toContainText("3 / 3");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
