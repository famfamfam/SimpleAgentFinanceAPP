import {test, expect} from '@playwright/test';
import {connectedChat} from './helpers/chat.js';
test.use({serviceWorkers:'block'});
const owner='00000000-0000-4000-8000-000000000999';
const settingsPage=page=>page.getByRole('link',{name:'Настройки',exact:true}).click();

for (const [button,path] of [['Новый ключ восстановления','recovery-key'],['Выйти на этом устройстве','logout']]) {
  test(`${path} binds a stale Settings action to the displayed user`,async({page})=>{
    await connectedChat(page); await settingsPage(page);
    let header;
    await page.route('**/api/'+path,async route=>{header=route.request().headers()['x-finance-user'];await route.fulfill({status:409,json:{error:'Пользователь изменился'}});});
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:button,exact:true}).click();
    await expect(page.locator('#toast')).toContainText('Пользователь изменился');
    expect(header).toBe(owner);
  });
}

test('backup file picker cannot overwrite the book selected while it was open',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>window.__financeReady);
  const backup=await page.evaluate(async()=>(await import('/db.js')).backup());
  await settingsPage(page);
  const chooser=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'Восстановить локальную копию',exact:true}).click();
  const picker=await chooser;
  await page.evaluate(async()=>{const db=await import('/db.js'),s=await db.meta('settings');await db.setMeta('settings',{...s,bookId:'00000000-0000-4000-8000-000000000200'});});
  page.on('dialog',dialog=>dialog.accept());
  await picker.setFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await expect(page.locator('#toast')).toContainText('Книга или пользователь изменились');
  expect(await page.evaluate(async()=>(await (await import('/db.js')).meta('settings')).bookId)).toBe('00000000-0000-4000-8000-000000000200');
});

test('restore rejects an owner change atomically before clearing data',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>window.__financeReady);
  const result=await page.evaluate(async()=>{
    const db=await import('/db.js'),settings=await db.meta('settings'),backup=await db.backup();
    await db.setMeta('settings',{...settings,userId:'changed-user'});
    let rejected=false;try {await db.restore(backup,settings);}catch {rejected=true;}
    return {rejected,userId:(await db.meta('settings')).userId};
  });
  expect(result).toEqual({rejected:true,userId:'changed-user'});
});

test('entry save rejects a user switch between its guard and the write transaction',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>window.__financeReady);
  await page.getByRole('button',{name:'Добавить',exact:true}).click();
  await page.getByLabel('Сумма',{exact:true}).fill('42.50');
  await page.getByRole('button',{name:'Продукты',exact:true}).click();
  await page.evaluate(async()=>{
    const db=await import('/db.js'),settings=await db.meta('settings'),transaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(stores,mode,...args){
      if(mode==='readwrite'&&Array.from(stores).includes('outbox')){
        IDBDatabase.prototype.transaction=transaction;
        const change=transaction.call(this,['meta'],'readwrite');
        change.objectStore('meta').put({id:'settings',value:{...settings,userId:'changed-user'}});
      }
      return transaction.call(this,stores,mode,...args);
    };
  });
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.locator('#modal .form-error')).toContainText('пользователь');
  expect(await page.evaluate(async()=>(await (await import('/db.js')).load()).pending.length)).toBe(0);
});

for (const status of [401,403]) {
  test(`background ${status} immediately refreshes the authentication banner`,async({page})=>{
    await connectedChat(page);
    await page.evaluate(async()=>(await import('/sync.js')).sync({wait:true}));
    await page.route('**/api/books/*/sync',route=>route.fulfill({status,json:{error:'Доступ завершён'}}));
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.error-banner')).toContainText(status===401?'Сессия завершена':'Доступ к общей книге отозван');
  });
}

test('manual synchronization reports server failure instead of silently swallowing it',async({page})=>{
  await connectedChat(page);
  await page.evaluate(async()=>(await import('/sync.js')).sync({wait:true}));
  await page.evaluate(async()=>{
    const db=await import('/db.js');await db.setMeta('settings',{...await db.meta('settings'),authRequired:true});
    await navigator.locks.request('finance-react-assistant',()=>{});
  });
  await page.route('**/api/books/*/sync',route=>route.fulfill({status:500,json:{error:'Тестовая ошибка сервера'}}));
  await page.getByRole('button',{name:'Синхронизировать',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('Тестовая ошибка сервера');
});

test('creating an account next to the transfer source selects it as the source',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>window.__financeReady);
  await page.getByRole('button',{name:'Добавить',exact:true}).click();
  await page.getByRole('button',{name:'Перевод',exact:true}).click();
  await page.getByLabel('Сумма',{exact:true}).fill('12');
  await page.locator('[data-action="entry-new-account"]').click();
  await page.getByLabel('Название',{exact:true}).fill('Новый отправитель');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Новая операция',exact:true})).toBeVisible();
  const source=await page.evaluate(async()=>(await (await import('/db.js')).load()).state.accounts.find(a=>a.name==='Новый отправитель').id);
  await expect(page.getByLabel('Откуда',{exact:true})).toHaveValue(source);
  await expect(page.getByLabel('Сумма',{exact:true})).toHaveValue('12');
});

test('import waits for pending changes in an already running synchronization',async({page,request})=>{
  await connectedChat(page);
  await page.evaluate(async()=>(await import('/sync.js')).sync({wait:true}));
  let release,started;const blocked=new Promise(resolve=>{release=resolve;}),received=new Promise(resolve=>{started=resolve;});
  await page.route('**/api/books/*/sync',async route=>{if(route.request().method()==='POST'){started();await blocked;}await route.fallback();});
  const state=await page.evaluate(async()=>{
    const db=await import('/db.js'),local=await db.load();
    await db.save('account',{id:'00000000-0000-4000-8000-000000000300',name:'Отправляемый счет',opening:'0.00',version:0,deleted:false},local.settings.bookId);
    return local.state;
  });
  const file=await request.post('/api/local-files/export',{data:state});expect(file.ok()).toBeTruthy();
  await page.route('**/api/books/*/import',route=>route.fulfill({json:{id:'preview',entries:[],commands:[],errors:[],duplicates:[]}}));
  try {
    await page.evaluate(()=>{void import('/sync.js').then(m=>m.sync());});await received;
    await settingsPage(page);const chooser=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'Импортировать XLSX',exact:true}).click();
    await (await chooser).setFiles({name:'empty.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await file.body()});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    release();
    await expect(page.getByRole('heading',{name:'Проверка импорта',exact:true})).toBeVisible();
  } finally {release();}
});

test('chat cancellation still refreshes financial entries when it removes pending commands',async({page})=>{
  await page.clock.setFixedTime(new Date('2025-01-02T12:00:00Z'));
  await page.goto('/');await page.waitForFunction(()=>window.__financeReady);
  await page.evaluate(async()=>{
    const db=await import('/db.js'),chat=await import('/chat-db.js'),local=await db.load(),s=local.settings;
    const input={id:'00000000-0000-4000-8000-000000000401',taskId:'00000000-0000-4000-8000-000000000402',text:'Тест',sentAt:'2025-01-02T12:00:00Z',chatEpoch:0,contextMode:'explicit'};
    const item={bookId:s.bookId,ownerId:s.userId,input};
    const entry={id:'00000000-0000-4000-8000-000000000403',kind:'expense',amount:'42.50',date:'2025-01-02',time:'12:00',accountId:local.state.accounts[0].id,categoryId:local.state.categories[0].id,note:'Будет отменено',tags:'',version:0,deleted:false};
    await chat.enqueue(item);await chat.complete({...item,scope:chat.scopeOf(s)},{text:'Проверьте',entries:[entry],action:'review'});
    await db.saveAssistant(input.id,s.bookId,[entry]);window.dispatchEvent(new Event('finance-updated'));
  });
  await page.getByRole('link',{name:'Операции',exact:true}).click();await expect(page.locator('.entry')).toHaveCount(1);
  await page.evaluate(async()=>{const db=await import('/db.js'),chat=await import('/chat-db.js');await chat.cancelTask(await db.meta('settings'),'00000000-0000-4000-8000-000000000402');});
  await expect(page.locator('.entry')).toHaveCount(0);
});

test('chat-only updates do not reload the financial base snapshot',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>window.__financeReady);
  const reads=await page.evaluate(async()=>{
    let count=0;const getAll=IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll=function(...args){if(this.name==='base')count++;return getAll.apply(this,args);};
    try {
      // Drain startup transactions so their refresh isn't attributed to the chat event.
      const db=await (await import('/db.js')).openDB();let before;
      do {
        before=count;
        await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','base','outbox'],'readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
        await new Promise(requestAnimationFrame);
      } while(count!==before);
      window.dispatchEvent(new Event('finance-chat-updated'));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return count-before;
    }
    finally {IDBObjectStore.prototype.getAll=getAll;}
  });
  expect(reads).toBe(0);
});
