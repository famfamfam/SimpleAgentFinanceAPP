import { test, expect } from '@playwright/test';
import { connectedChat } from './helpers/chat.js';
test.use({ serviceWorkers: 'block' });

test('a required sync waits for another tab to release the sync lock', async ({page}) => {
  await connectedChat(page);
  await page.evaluate(async () => {
    await (await import('/sync.js')).sync({wait:true});
    await new Promise(resolve => {
      navigator.locks.request('finance-sync', () => new Promise(release => { window.releaseSyncLock = release; resolve(); }));
    });
  });
  try {
    const finished = await page.evaluate(async () => {
      window.requiredSyncDone = false;
      window.requiredSync = import('/sync.js').then(m => m.sync({wait:true})).then(() => { window.requiredSyncDone = true; });
      await new Promise(requestAnimationFrame);
      return window.requiredSyncDone;
    });
    expect(finished).toBe(false);
  } finally {
    await page.evaluate(() => window.releaseSyncLock());
  }
  await page.evaluate(() => window.requiredSync);
  expect(await page.evaluate(() => window.requiredSyncDone)).toBe(true);
});

test('switching books clears filters from the previous book', async ({page}) => {
  await page.goto('/'); await page.waitForFunction(() => window.__financeReady);
  await page.getByRole('link', {name:'Операции', exact:true}).click();
  await page.getByRole('button', {name:'Фильтры', exact:true}).click();
  await page.getByLabel('Счет', {exact:true}).selectOption({label:'Основной'});
  await page.getByRole('button', {name:'Применить', exact:true}).click();
  await expect(page.locator('.filter-count')).toHaveText('1');
  await page.getByRole('searchbox', {name:'Поиск операций'}).fill('старый фильтр');
  await page.evaluate(async () => {
    const db=await import('/db.js'), settings=await db.meta('settings');
    await db.setMeta('settings', {...settings, bookId:crypto.randomUUID()});
    window.dispatchEvent(new Event('finance-updated'));
  });
  await expect(page.locator('.filter-count')).toHaveCount(0);
  await expect(page.getByRole('searchbox', {name:'Поиск операций'})).toHaveValue('');
});

test('an import preview cannot be applied after the user changes in the same book', async ({page,request}) => {
  await page.goto('/'); await page.waitForFunction(() => window.__financeReady);
  const state=await page.evaluate(async()=>(await (await import('/db.js')).load()).state);
  const entry={id:'00000000-0000-4000-8000-000000000123',kind:'expense',amount:'42.50',date:'2025-01-01',time:'12:00',accountId:state.accounts[0].id,categoryId:state.categories[0].id,note:'Проверка импорта',tags:'',version:0,deleted:false};
  const file=await request.post('/api/local-files/export',{data:{...state,entries:[entry]}}); expect(file.ok()).toBeTruthy();
  await page.getByRole('link',{name:'Настройки',exact:true}).click();
  const chooser=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'Импортировать XLSX',exact:true}).click();
  await (await chooser).setFiles({name:'test.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await file.body()});
  await expect(page.getByRole('heading',{name:'Проверка импорта',exact:true})).toBeVisible();
  await page.evaluate(async()=>{const db=await import('/db.js'), settings=await db.meta('settings');await db.setMeta('settings',{...settings,userId:'changed-user'});});
  await page.getByRole('button',{name:'Импортировать',exact:true}).click();
  await expect(page.locator('#modal .form-error')).toContainText('пользователь');
  expect(await page.evaluate(async()=>(await (await import('/db.js')).load()).state.entries.length)).toBe(0);
});
