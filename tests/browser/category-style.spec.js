import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });

test("category AI cycles locally and ignores a renamed form", async ({ page }) => {
  await page.goto("/"); await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async () => {
    const db = await import("/db.js"); await db.setMeta("settings", { ...await db.meta("settings"), connected: true });
    window.dispatchEvent(new Event("finance-updated"));
  });
  let calls = 0, release;
  await page.route("**/category-style", async route => {
    calls++;
    const input = route.request().postDataJSON();
    if (calls === 2) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { suggestions: input.icons.slice(0,3).map((v,i) => ({ icon:v.id, color:input.colors[i] })) } });
  });
  await page.getByRole("link", { name: "Настройки", exact:true }).click();
  await page.getByRole("button", { name:"Добавить категорию", exact:true }).click();
  const ai = page.getByRole("button",{name:"Подобрать значок и цвет с ИИ"});
  await expect(ai).toBeDisabled(); await page.locator("#catalog-name").fill("Еда");
  for(let i=0;i<3;i++) { await ai.click(); await expect(ai).toBeEnabled(); }
  expect(calls).toBe(1);
  const before = await page.locator("input[name=icon]").inputValue();
  await ai.click(); await expect.poll(()=>calls).toBe(2);
  await page.locator("#catalog-name").fill("Транспорт"); release(); await expect(ai).toBeEnabled();
  expect(await page.locator("input[name=icon]").inputValue()).toBe(before);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("category style errors are visible above the dialog and a retry works",async({page})=>{
  await page.goto("/");await page.waitForFunction(()=>window.__financeReady);
  await page.evaluate(async()=>{const db=await import("/db.js");await db.setMeta("settings",{...await db.meta("settings"),connected:true});window.dispatchEvent(new Event("finance-updated"));});
  let calls=0;
  await page.route("**/category-style",async route=>{
    const input=route.request().postDataJSON();calls++;
    return route.fulfill(calls===1?{status:502,json:{error:"Провайдер временно недоступен"}}:{json:{suggestions:input.icons.slice(0,3).map((v,i)=>({icon:v.id,color:input.colors[i]}))}});
  });
  await page.getByRole("link",{name:"Настройки",exact:true}).click();await page.getByRole("button",{name:"Добавить категорию",exact:true}).click();
  await page.getByLabel("Название",{exact:true}).fill("Авто");
  const ai=page.getByRole("button",{name:"Подобрать значок и цвет с ИИ"});await ai.click();
  await expect(page.locator("dialog #toast")).toContainText("Провайдер временно недоступен");
  await expect(page.locator("dialog #toast")).toBeInViewport();await expect(ai).toBeEnabled();
  await ai.click();await expect.poll(()=>calls).toBe(2);await expect(page.locator("input[name=icon]")).toHaveValue("basket");
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();
  await page.getByRole("button",{name:"Добавить категорию",exact:true}).click();
  await expect(page.locator("#toast")).toHaveCount(1);
});

test("category AI requests new alternatives after every three clicks without saving the form", async ({page}) => {
  await page.goto("/"); await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.setMeta("settings", {...await db.meta("settings"), connected:true});
    window.dispatchEvent(new Event("finance-updated"));
  });
  let calls = 0, previous = [];
  await page.route("**/category-style", async route => {
    const input = route.request().postDataJSON();
    expect(input.exclude).toEqual(previous);
    previous = input.icons.slice(0,3).map(v => ({icon:v.id, color:input.colors[calls]}));
    calls++;
    await route.fulfill({json:{suggestions:previous}});
  });
  await page.getByRole("link", {name:"Настройки", exact:true}).click();
  await page.getByRole("button", {name:"Добавить категорию", exact:true}).click();
  await page.locator("#catalog-name").fill("Тест альтернатив");
  const ai = page.getByRole("button", {name:"Подобрать значок и цвет с ИИ"});
  for (let click=0; click<9; click++) {
    await ai.click(); await expect(ai).toBeEnabled();
    await expect(page.locator("input[name=icon]")).toHaveValue(previous[click%3].icon);
    await expect(page.locator("input[name=color]")).toHaveValue(previous[click%3].color);
  }
  expect(calls).toBe(3);
  expect(await page.evaluate(async () => (await (await import("/db.js")).load()).state.categories.some(c => c.name === "Тест альтернатив"))).toBe(false);
});
