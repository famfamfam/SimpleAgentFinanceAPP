import {test,expect} from "@playwright/test";
test.use({serviceWorkers:"block"});

test("compact entry puts nine categories before the date and a collapsed account",async({page,context})=>{
 await page.goto("/");await page.waitForFunction(()=>window.__financeReady);await context.setOffline(true);
 await page.getByRole("button",{name:"Добавить",exact:true}).click();
 await expect(page.locator(".category-choice")).toHaveCount(9);
 await expect(page.locator("#entry-account-details")).not.toHaveAttribute("open");
 await expect(page.locator("#entry-account-details summary")).toHaveText("Счет: Основной");
 for(const width of [320,360,393,430]){
  await page.setViewportSize({width,height:852});
  const fit=await page.evaluate(()=>({amount:document.querySelector('.amount-input').getBoundingClientRect().height,categories:document.querySelector('.categories-grid').getBoundingClientRect().bottom,date:document.querySelector('#entry-date').getBoundingClientRect().top,overflow:document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth}));
  expect(fit.amount).toBeLessThan(70);expect(fit.categories).toBeLessThan(fit.date);expect(fit.overflow).toBe(false);
 }
 await page.getByLabel("Сумма",{exact:true}).fill("123");await page.getByLabel("Сумма",{exact:true}).press("Enter");
 await expect(page.getByLabel("Сумма",{exact:true})).not.toBeFocused();
 await expect(page.getByRole("heading",{name:"Новая операция",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Продукты",exact:true}).click();
 await page.getByRole("button",{name:"Сохранить",exact:true}).click();
 await expect(page.locator('#modal')).not.toBeVisible();
 const saved=await page.evaluate(async()=>{const s=await(await import('/db.js')).load();return {entry:s.state.entries[0],account:s.state.accounts[0].id};});
 expect(saved.entry.accountId).toBe(saved.account);expect(saved.entry.amount).toBe("123.00");
});

test("changing the collapsed account and adding one keeps the operation draft",async({page,context})=>{
 await page.goto("/");await page.waitForFunction(()=>window.__financeReady);await context.setOffline(true);
 await page.getByRole("button",{name:"Добавить",exact:true}).click();
 await page.getByLabel("Сумма",{exact:true}).fill("77");
 await page.locator("#entry-account-details summary").click();
 await page.getByRole("button",{name:"Новый счет",exact:true}).click();
 await page.getByLabel("Название",{exact:true}).fill("Карта");
 await page.getByRole("button",{name:"Сохранить",exact:true}).click();
 await expect(page.getByLabel("Сумма",{exact:true})).toHaveValue("77");
 await expect(page.locator("#entry-account-details summary")).toHaveText("Счет: Карта");
 await page.getByLabel("Счет",{exact:true}).selectOption({label:"Основной"});
 await expect(page.locator("#entry-account-details summary")).toHaveText("Счет: Основной");
 await page.getByRole("button",{name:/Все категории/}).click();
 await expect(page.getByLabel("Счет",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Животина",exact:true}).click();
 await page.getByRole("button",{name:"Свернуть категории",exact:true}).click();
 await expect(page.locator(".category-choice")).toHaveCount(9);
 await expect(page.getByRole("button",{name:"Животина",exact:true})).toHaveAttribute("aria-pressed","true");
});
