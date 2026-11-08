import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const ownerA = '00000000-0000-4000-8000-000000000901';
const ownerB = '00000000-0000-4000-8000-000000000902';
const entryA = {draft:{id:'00000000-0000-4000-8000-000000000903',kind:'expense',amount:'73',note:'Личный черновик A',date:'2025-01-02',time:'10:15',accountId:'',categoryId:'',tags:''},expanded:true};
const entryB = {draft:{...entryA.draft,id:'00000000-0000-4000-8000-000000000904',amount:'84',note:'Личный черновик B'},expanded:false};

async function start(page) {
  await page.clock.install({time:new Date('2025-01-02T12:00:00Z')});
  await page.route('**/api/**', route => route.fulfill({json:[]}));
  await page.goto('/');
  await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async userId => {
    const db = await import('/db.js');
    await db.setMeta('settings', {...await db.meta('settings'), userId, connected:false});
  }, ownerA);
  await page.reload();
  await page.waitForFunction(() => window.__financeReady);
}
async function switchOwner(page, userId) {
  await page.evaluate(async userId => {
    const db = await import('/db.js');
    await db.setMeta('settings', {...await db.meta('settings'), userId});
    window.dispatchEvent(new Event('finance-updated'));
  }, userId);
}

test('switching users before loading legacy drafts does not give A drafts to B, and neither user loses drafts', async ({page}) => {
  await start(page);
  await page.evaluate(async entry => {
    const db = await import('/db.js'), settings = await db.meta('settings');
    // A rollback client wrote the original value-only records before this client loaded them.
    await db.transaction(['meta'], tx => {
      tx.objectStore('meta').put({id:'ai-draft:'+settings.bookId,value:'Личный текст A'});
      tx.objectStore('meta').put({id:'entry-draft:'+settings.bookId,value:entry});
    });
  }, entryA);
  await switchOwner(page, ownerB);
  await page.getByRole('link', {name:'Помощник',exact:true}).click();
  await expect(page.locator('#ai-text')).toBeEnabled();
  await expect(page.locator('#ai-text')).toHaveValue('');
  await expect(page.locator('[data-action="entry-return"]')).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const db = await import('/db.js'), settings = await db.meta('settings'), connection = await db.openDB();
    const store = connection.transaction('meta').objectStore('meta');
    const [text,entry] = await Promise.all([db.request(store.get('ai-draft:'+settings.bookId)),db.request(store.get('entry-draft:'+settings.bookId))]);
    return {text:text.value,entry:entry.value};
  })).toEqual({text:'Личный текст A',entry:entryA});

  await page.locator('#ai-text').fill('Личный текст B');
  await expect.poll(() => page.evaluate(async () => {
    const db = await import('/db.js');
    return db.meta('ai-draft:'+(await db.meta('settings')).bookId);
  })).toBe('Личный текст B');
  await page.evaluate(async entry => {
    const db = await import('/db.js');
    await db.setMeta('entry-draft:'+(await db.meta('settings')).bookId, entry);
    window.dispatchEvent(new Event('finance-assistant-draft'));
  }, entryB);
  await expect(page.locator('[data-action="entry-return"]')).toBeVisible();

  await switchOwner(page, ownerA);
  await expect(page.locator('#ai-text')).toHaveValue('Личный текст A');
  await expect(page.locator('[data-action="entry-return"]')).toBeVisible();
  expect(await page.evaluate(async () => {
    const db = await import('/db.js'), chat = await import('/chat-db.js');
    return chat.readDraft(await db.meta('settings'),'entry');
  })).toEqual(entryA);
  await switchOwner(page, ownerB);
  await expect(page.locator('#ai-text')).toHaveValue('Личный текст B');
  expect(await page.evaluate(async () => {
    const db = await import('/db.js'), chat = await import('/chat-db.js');
    return chat.readDraft(await db.meta('settings'),'entry');
  })).toEqual(entryB);
});

test('stale draft callbacks cannot read or overwrite the newly active owner in the same book', async ({page}) => {
  await start(page);
  const result = await page.evaluate(async ({ownerB,entryA,entryB}) => {
    const db = await import('/db.js'), chat = await import('/chat-db.js'), a = await db.meta('settings');
    await chat.writeDraft(a,'Текст A');
    await chat.writeDraft(a,entryA,'entry');
    const b = {...a,userId:ownerB};
    await db.setMeta('settings',b);
    await chat.writeDraft(b,'Текст B');
    await chat.writeDraft(b,entryB,'entry');
    const stale = await Promise.allSettled([
      chat.readDraft(a), chat.readDraft(a,'entry'), chat.writeDraft(a,'Запоздалый текст A'), chat.writeDraft(a,entryA,'entry')
    ]);
    const current = {text:await chat.readDraft(b),entry:await chat.readDraft(b,'entry')};
    const canonical = {text:await db.meta('ai-draft:'+a.bookId),entry:await db.meta('entry-draft:'+a.bookId)};
    await db.setMeta('settings',a);
    const original = {text:await chat.readDraft(a),entry:await chat.readDraft(a,'entry')};
    return {statuses:stale.map(x=>x.status),current,canonical,original};
  }, {ownerB,entryA,entryB});
  expect(result).toEqual({
    statuses:['rejected','rejected','rejected','rejected'],
    current:{text:'Текст B',entry:entryB},canonical:{text:'Текст B',entry:entryB},original:{text:'Текст A',entry:entryA}
  });
});

test('an Assistant still mounted for A cannot save its textarea after storage switches to B', async ({page}) => {
  await start(page);
  await page.evaluate(async () => {
    const db = await import('/db.js');
    await db.setMeta('ai-draft:'+(await db.meta('settings')).bookId,'Текст A');
  });
  await page.getByRole('link', {name:'Помощник',exact:true}).click();
  await expect(page.locator('#ai-text')).toHaveValue('Текст A');
  // Do not refresh React yet: this is the old screen's callback, not the new owner's.
  await page.evaluate(async ownerB => {
    const db = await import('/db.js'), a = await db.meta('settings');
    await db.setMeta('settings', {...a,userId:ownerB});
    await db.setMeta('ai-draft:'+a.bookId,'Текст B');
  }, ownerB);
  await page.locator('#ai-text').fill('Запоздалый текст A');
  await expect(page.locator('#toast')).toContainText('пользователь');
  await page.evaluate(() => window.dispatchEvent(new Event('finance-updated')));
  await expect(page.locator('#ai-text')).toHaveValue('Текст B');
  await switchOwner(page, ownerA);
  await expect(page.locator('#ai-text')).toHaveValue('Текст A');
});

test('enqueue clears only the sender draft and leaves rollback-compatible values and the other owner intact', async ({page}) => {
  await start(page);
  const result = await page.evaluate(async ownerB => {
    const db = await import('/db.js'), chat = await import('/chat-db.js'), a = await db.meta('settings');
    await chat.writeDraft(a,'Неотправленный текст A');
    const b = {...a,userId:ownerB};
    await db.setMeta('settings',b);
    await chat.writeDraft(b,'Сообщение B');
    await chat.enqueue({bookId:b.bookId,ownerId:b.userId,input:{id:'00000000-0000-4000-8000-000000000905',taskId:'00000000-0000-4000-8000-000000000906',text:'Сообщение B',sentAt:'2025-01-02T12:00:00.000Z',chatEpoch:0,contextMode:'explicit'}});
    const sent = await chat.readDraft(b), canonical = await db.meta('ai-draft:'+b.bookId);
    await db.setMeta('settings',a);
    const other = await chat.readDraft(a);
    await db.setMeta('settings',b);
    return {sent,canonical,other,returned:await chat.readDraft(b),version:(await db.openDB()).version};
  }, ownerB);
  expect(result).toEqual({sent:'',canonical:'',other:'Неотправленный текст A',returned:'',version:4});
});
