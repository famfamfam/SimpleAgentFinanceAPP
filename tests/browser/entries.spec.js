import {test,expect} from "@playwright/test";
test.use({serviceWorkers:"block"});
async function seed(page){
 await page.goto("/");await page.waitForFunction(()=>window.__financeReady);
 await page.evaluate(async()=>{
  const db=await import('/db.js'),m=await import('/model.js'),b=await db.backup(),s=b.base[0].data;
  const main=s.accounts[0].id,second=crypto.randomUUID();s.accounts.push({...s.accounts[0],id:second,name:'Карта'});
  const row={kind:'expense',amount:'100.00',date:m.today(),time:'12:00',accountId:main,categoryId:s.categories[0].id,note:'Магазин',tags:'',version:1,deleted:false};
  s.entries=[{...row,id:crypto.randomUUID()},{...row,id:crypto.randomUUID(),amount:'200.00',time:'11:00',accountId:second,categoryId:s.categories[1].id},{...row,id:crypto.randomUUID(),kind:'income',amount:'500.00',time:'13:00',categoryId:s.categories[8].id,note:'Зарплата'},{...row,id:crypto.randomUUID(),kind:'transfer',amount:'50.00',time:'10:00',toAccountId:second,categoryId:'',note:'Перевод'}];
  await db.restore(b);window.dispatchEvent(new Event('finance-updated'));
 });
 await page.getByRole('link',{name:'Операции',exact:true}).click();await expect(page.locator('.entry')).toHaveCount(4);
}
async function filters(page){await page.getByRole('button',{name:'Фильтры',exact:true}).click();}
async function apply(page){await page.getByRole('button',{name:'Применить',exact:true}).click();}

test('compact history shows operations early and keeps period, search and filters visible',async({page})=>{
 await seed(page);
 for(const width of [320,360,393,430]){
  await page.setViewportSize({width,height:624});
  for(const name of ['Добавить','Выбрать период','Предыдущий период','Следующий период','Фильтры'])await expect(page.getByRole('button',{name,exact:true})).toBeInViewport();
  await expect(page.getByRole('searchbox',{name:'Поиск операций'})).toBeInViewport();
  const bounds=await page.evaluate(()=>({top:document.querySelector('.entry').getBoundingClientRect().top,overflow:document.documentElement.scrollWidth>innerWidth}));
  expect(bounds.top).toBeLessThan(260);expect(bounds.overflow).toBe(false);
 }
 await expect(page.getByRole('heading',{name:'Операции',exact:true})).toHaveCount(1);
 await expect(page.locator('#list-total')).toHaveText(/Записей: 4.*800/);
 await page.getByRole('searchbox',{name:'Поиск операций'}).fill('Магазин');
 await expect(page.locator('.entry')).toHaveCount(2);await expect(page.locator('#list-total')).toHaveText(/Записей: 2.*300/);
 await page.getByRole('searchbox',{name:'Поиск операций'}).fill('Нет такого');
 await expect(page.locator('#entries-list')).toContainText('Операций не найдено');
});

test('filters apply together, remain visible as chips and reset without changing the period',async({page})=>{
 await seed(page);await filters(page);
 await page.getByLabel('Счет',{exact:true}).selectOption({label:'Карта'});await page.getByRole('button',{name:'Закрыть',exact:true}).click();
 await expect(page.locator('.entry')).toHaveCount(4);await expect(page.locator('.filter-count')).toHaveCount(0);await filters(page);
 await page.getByLabel('Счет',{exact:true}).selectOption({label:'Основной'});
 await page.getByLabel('Тип операции',{exact:true}).selectOption('expense');
 await page.getByLabel('Категория',{exact:true}).selectOption({label:'Продукты'});await apply(page);
 await expect(page.locator('.entry')).toHaveCount(1);await expect(page.locator('.filter-count')).toHaveText('3');
 await expect(page.getByRole('group',{name:'Активные фильтры'})).toContainText('Основной');
 await expect(page.getByRole('group',{name:'Активные фильтры'})).toContainText('Продукты');
 await page.getByRole('button',{name:'Сбросить категорию',exact:true}).click();await expect(page.locator('.filter-count')).toHaveText('2');
 await page.getByRole('button',{name:'Сбросить счет',exact:true}).click();await expect(page.locator('.entry')).toHaveCount(2);
 await page.getByRole('button',{name:'Сбросить тип операции',exact:true}).click();await expect(page.locator('.entry')).toHaveCount(4);await expect(page.locator('.filter-count')).toHaveCount(0);
 await page.getByRole('searchbox',{name:'Поиск операций'}).fill('Магазин');await filters(page);
 await page.getByLabel('Тип операции',{exact:true}).selectOption('income');await apply(page);await expect(page.locator('.entry')).toHaveCount(0);
 const period=await page.getByRole('button',{name:'Выбрать период',exact:true}).textContent();
 await filters(page);await page.getByRole('button',{name:'Сбросить фильтры',exact:true}).click();
 await expect(page.locator('.entry')).toHaveCount(4);await expect(page.getByRole('searchbox',{name:'Поиск операций'})).toHaveValue('');
 await expect(page.getByRole('button',{name:'Выбрать период',exact:true})).toHaveText(period);
});

test('changing operation kind clears an incompatible category and transfers include the receiving account',async({page})=>{
 await seed(page);await filters(page);
 await page.getByLabel('Тип операции',{exact:true}).selectOption('expense');await page.getByLabel('Категория',{exact:true}).selectOption({label:'Продукты'});await apply(page);
 await filters(page);await page.getByLabel('Тип операции',{exact:true}).selectOption('income');
 await expect(page.getByLabel('Категория',{exact:true})).toHaveValue('');await apply(page);await expect(page.locator('.entry')).toHaveCount(1);await expect(page.locator('.entry')).toContainText('Зарплата');
 await filters(page);await page.getByLabel('Тип операции',{exact:true}).selectOption('transfer');await expect(page.getByLabel('Категория',{exact:true})).toBeDisabled();
 await page.getByLabel('Счет',{exact:true}).selectOption({label:'Карта'});await apply(page);
 await expect(page.locator('.entry')).toHaveCount(1);await expect(page.locator('.entry')).toContainText('Перевод');await expect(page.locator('#list-total')).toHaveText('Записей: 1');
});
