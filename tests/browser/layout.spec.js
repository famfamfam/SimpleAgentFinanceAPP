import { test, expect } from "@playwright/test";
test.use({ serviceWorkers:"block" });

test("dashboard, category editor and chat fit narrow screens and keyboard height",async({page})=>{
  await page.goto("/");await page.waitForFunction(()=>window.__financeReady);
  await page.evaluate(async()=>{
    const db=await import("/db.js"),m=await import("/model.js"),b=await db.backup(),s=b.base[0].data;
    s.categories[0].name="Очень длинное название категории для проверки переноса строк на экране";
    s.entries=[{id:crypto.randomUUID(),kind:"expense",amount:"999999999.99",date:m.today(),accountId:s.accounts[0].id,categoryId:s.categories[0].id,note:"",tags:"",version:1,deleted:false}];
    await db.restore(b);window.dispatchEvent(new Event("finance-updated"));
  });
  for(const width of [320,360,393,430]) {
    await page.setViewportSize({width,height:852});
    await page.getByRole("link",{name:"Обзор",exact:true}).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole("link",{name:"Настройки",exact:true}).click();await page.getByRole("button",{name:"Добавить категорию",exact:true}).click();
    await page.getByLabel("Название",{exact:true}).fill("Категория с длинным названием");
    const spacing=await page.evaluate(()=>{
      const select=document.querySelector("#icon-group").getBoundingClientRect(),grid=document.querySelector(".icon-picker").getBoundingClientRect();
      return {gap:grid.top-select.bottom,overflow:document.querySelector("dialog").scrollWidth>document.querySelector("dialog").clientWidth};
    });expect(spacing.overflow).toBe(false);expect(spacing.gap).toBeGreaterThanOrEqual(12);
    await page.getByRole("button",{name:"Закрыть",exact:true}).click();
    await page.getByRole("link",{name:"Помощник",exact:true}).click();
    await expect(page.locator("#ai-text")).toBeVisible();
    await page.locator("#ai-text").fill("");
    const row=await page.evaluate(()=>{
      const field=document.querySelector('#ai-text');field.focus();
      const elements=[document.querySelector('[data-action="ai-photo"]'),field,document.querySelector('.ai-tools [data-action="ai-record"]'),document.querySelector('#ai-form [type=submit]')];
      return {rects:elements.map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,height:r.height};}),outline:getComputedStyle(field).outlineStyle};
    });
    expect(row.outline).toBe("none");expect(row.rects[1].height).toBeLessThanOrEqual(48);
    for(let i=1;i<row.rects.length;i++)expect(row.rects[i-1].right).toBeLessThanOrEqual(row.rects[i].left);
    await page.setViewportSize({width,height:460});await page.locator("#ai-text").fill("Текст с переносом строки\nВторая строка");
    const fit=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,bottom:document.querySelector("#ai-form").getBoundingClientRect().bottom,nav:document.querySelector(".nav").getBoundingClientRect().top}));
    expect(fit.overflow).toBe(false);expect(fit.bottom).toBeLessThanOrEqual(fit.nav);
  }
});
