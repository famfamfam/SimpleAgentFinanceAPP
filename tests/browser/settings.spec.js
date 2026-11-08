import {test, expect} from "@playwright/test";
test.use({serviceWorkers:"block"});
async function ready(page) {
  await page.goto("/"); await page.waitForFunction(() => window.__financeReady);
}
async function top(page, title) {
  await expect(page.getByRole("heading", {name:title, exact:true})).toBeInViewport();
  await expect.poll(() => page.locator("dialog").evaluate(el => el.scrollTop)).toBe(0);
  expect(await page.locator("dialog").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
}

test("settings put catalogs first and keep data accessible without a long category list", async ({page}) => {
  await ready(page);
  await page.getByRole("link", {name:"Настройки", exact:true}).click();
  for(const width of [320,393,430]) {
    await page.setViewportSize({width,height:852});
    await expect(page.getByRole("button", {name:"Категории", exact:true})).toBeInViewport();
    await expect(page.getByRole("button", {name:"Счета", exact:true})).toBeInViewport();
    await expect(page.getByRole("button", {name:"Импортировать XLSX", exact:true})).toBeInViewport();
    const order=await page.locator(".settings-grid h3").allTextContents();
    expect(order).toEqual(["Учет","Данные"," Синхронизация","Приложение"]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.getByText("Диагностика и хранение", {exact:true}).click();
  await expect(page.getByRole("button", {name:"Скорость и диагностика",exact:true})).toBeVisible();
  await page.evaluate(async () => {
    const db=await import("/db.js");
    await db.setMeta("settings",{...await db.meta("settings"),connected:true});
    window.dispatchEvent(new Event("finance-updated"));
  });
  await expect(page.getByRole("heading",{name:"Доступ и интеграции",exact:true})).toBeVisible();
  for(const name of ["Участники и приглашение","Устройства","Новый ключ восстановления","MCP и внешние агенты","Выйти на этом устройстве"])
    await expect(page.getByRole("button",{name,exact:true})).toBeVisible();
});

test("category list filters names and kinds and returns after editing without losing filters", async ({page,context}) => {
  await ready(page); await context.setOffline(true);
  await page.getByRole("link", {name:"Настройки",exact:true}).click();
  await page.getByRole("button", {name:"Категории",exact:true}).click();
  await page.getByLabel("Поиск", {exact:true}).fill("Продукты");
  await expect(page.locator("[data-catalog-id]:visible")).toHaveCount(1);
  await page.getByLabel("Тип категории").selectOption("income");
  await expect(page.locator("#catalog-empty")).toBeVisible();
  await page.getByLabel("Тип категории").selectOption("expense");
  await page.getByRole("button", {name:"Изменить категорию Продукты",exact:true}).click();
  await top(page,"Изменить категорию");
  await page.getByLabel("Название",{exact:true}).fill("Продукты дома");
  await page.getByRole("button",{name:"Сохранить",exact:true}).click();
  await top(page,"Категории");
  await expect(page.getByLabel("Поиск",{exact:true})).toHaveValue("Продукты");
  await expect(page.getByLabel("Тип категории")).toHaveValue("expense");
  await expect(page.locator("[data-catalog-id]:visible")).toHaveText(/Продукты дома/);
  await page.getByRole("button",{name:"Новая категория",exact:true}).click();
  await top(page,"Новая категория");
  await expect(page.locator('.dialog-head [data-action="close"]')).toBeFocused();
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();
  await top(page,"Категории");
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();
  await page.getByRole("button",{name:"Счета",exact:true}).click();
  await top(page,"Счета");
  await page.getByRole("button",{name:"Новый счет",exact:true}).click();
  await top(page,"Новый счет");
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();
  await top(page,"Счета");
});

test("a catalog left open cannot edit a book switched by another tab", async ({page}) => {
  await ready(page);
  await page.getByRole("link",{name:"Настройки",exact:true}).click();
  await page.getByRole("button",{name:"Категории",exact:true}).click();
  await page.evaluate(async () => {
    const db=await import("/db.js");
    await db.setMeta("settings",{...await db.meta("settings"),bookId:crypto.randomUUID()});
  });
  await page.getByRole("button",{name:"Изменить категорию Продукты",exact:true}).click();
  await expect(page.locator("dialog #toast")).toContainText("Книга изменилась");
  await expect(page.getByRole("heading",{name:"Категории",exact:true})).toBeVisible();
});

for(const width of [320,430]) test(`nested and reopened dialogs always start at the top at ${width}px`, async ({page})=>{
  await page.setViewportSize({width,height:700});await ready(page);
  await page.getByRole("button",{name:"Добавить",exact:true}).click();
  await page.getByLabel("Сумма",{exact:true}).fill("123");
  await page.getByRole("button",{name:"Новая категория",exact:true}).click();
  await top(page,"Новая категория");
  await page.getByText("Больше цветов",{exact:true}).click();
  await page.locator("dialog").evaluate(el=>el.scrollTop=el.scrollHeight);
  expect(await page.locator("dialog").evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await top(page,"Новая операция");
  await expect(page.getByLabel("Сумма",{exact:true})).toHaveValue("123");
  await page.locator("#entry-account-details summary").click();
  await page.getByRole("button",{name:"Новый счет",exact:true}).click();
  await top(page,"Новый счет");
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();
  await top(page,"Новая операция");
  await page.getByRole("button",{name:/Все категории/}).click();
  await expect(page.getByLabel("Поиск категории")).toBeVisible();
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();
  await page.getByRole("link",{name:"Настройки",exact:true}).click();
  await page.getByRole("button",{name:"Категории",exact:true}).click();
  await page.getByRole("button",{name:"Изменить категорию Животина",exact:true}).click();
  await top(page,"Изменить категорию");
  await page.locator("dialog").evaluate(el=>el.scrollTop=el.scrollHeight);
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();
  await top(page,"Категории");
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();
  await page.getByRole("button",{name:"Добавить категорию",exact:true}).click();
  await top(page,"Новая категория");
});
