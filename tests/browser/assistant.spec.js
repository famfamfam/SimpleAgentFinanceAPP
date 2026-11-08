import { test, expect } from "@playwright/test";
import { initialState } from "../../backend/web/model.js";
test.use({ serviceWorkers: "block" });

test("AI queue changes are atomic across enqueue, completion and cancellation", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js"), settings = await db.meta("settings");
    const items = [0, 1, 2, 3].map(i => ({ bookId: settings.bookId, input: { id: crypto.randomUUID(), text: "request " + i } }));
    await Promise.all(items.slice(0, 3).map(item => db.enqueueAI(item)));
    await Promise.all([db.completeAI(items[0], { text: "ready", entries: [] }), db.enqueueAI(items[3])]);
    await db.editAI(items[1].input.id, settings.bookId, null);
    await db.completeAI(items[1], { text: "too late", entries: [] });
    await Promise.all([db.markAISaved(items[0].input.id, settings.bookId), db.completeAI(items[2], { text: "second", entries: [] })]);
    let rejected = false;
    try { await db.enqueueAI({ ...items[0], bookId: crypto.randomUUID() }); } catch { rejected = true; }
    return { queue: (await db.meta("ai-queue")).map(x => x.input.text).sort(), results: (await db.meta("ai-results")).map(x => [x.result.text, x.saved]), rejected };
  });
  expect(result).toEqual({ queue: ["request 3"], results: [["ready", true], ["second", false]], rejected: true });
});

test("AI retries stop after three failures and the user can retry or cancel", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/assistant")) {
      calls++;
      await route.fulfill({ status: calls <= 3 ? 502 : 200, json: calls <= 3 ? { error: "Провайдер временно недоступен" } : { text: "Готово", entries: [] } });
    } else if (path.endsWith("/sync")) await route.fulfill({ json: { revision: 1, state: initialState(), results: [] } });
    else if (path === "/api/me") await route.fulfill({ json: { user: { id: "test-user", nickname: "Тест" }, books: [], aiAvailable: true } });
    else await route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async () => {
    const db = await import("/db.js"), settings = await db.meta("settings");
    await db.setMeta("settings", { ...settings, connected: true, userId: "test-user" });
  });
  await page.reload();
  await page.getByRole("link", { name: "Помощник", exact: true }).click();
  await page.locator("#ai-text").fill("Кофе 250");
  await page.getByRole("button", { name: /Отправить/ }).click();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect.poll(() => page.evaluate(async () => ((await (await import("/db.js")).meta("ai-queue")) || [])[0]?.attempts)).toBe(attempt);
    if (attempt < 3) {
      await page.evaluate(async () => {
        const db = await import("/db.js"), item = (await db.meta("ai-queue"))[0];
        await db.editAI(item.input.id, item.bookId, { retryAt: 0 });
        window.dispatchEvent(new Event("online"));
      });
    }
  }
  expect(calls).toBe(3);
  expect(await page.evaluate(async () => (await (await import("/db.js")).meta("ai-queue"))[0].paused)).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeVisible();
  expect(calls).toBe(3);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.locator(".assistant-result")).toContainText("Готово");
  expect(calls).toBe(4);
  expect(await page.evaluate(async () => (await (await import("/db.js")).meta("ai-queue")).length)).toBe(0);
});

async function connected(page, answer) {
  let state = initialState(), revision = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/assistant")) return answer(route);
    if (path.endsWith("/sync") || path.endsWith("/apply")) {
      const commands = route.request().postDataJSON()?.commands || [];
      for (const c of commands) {
        const key = { entry:"entries", category:"categories", account:"accounts" }[c.entity];
        state[key] = [...state[key].filter(x=>x.id!==c.data.id), { ...c.data, version:++revision }];
      }
      return route.fulfill({ json:{ state, revision, results:commands.map(c=>({ id:c.id,status:"ok",version:revision })) } });
    }
    return route.fulfill({ json:path === "/api/me" ? { user:{id:"test-user",nickname:"Тест"}, books:[] } : [] });
  });
  await page.goto("/"); await page.waitForFunction(()=>window.__financeReady);
  await page.evaluate(async()=>{const db=await import("/db.js"); await db.setMeta("settings",{...await db.meta("settings"),connected:true,userId:"test-user"});});
  await page.reload(); await page.waitForFunction(()=>window.__financeReady);
  await page.getByRole("link",{name:"Помощник",exact:true}).click();
}
function draft(input, categoryId=initialState().categories[0].id) {
  return { id:input.taskId, kind:"expense",amount:"200.00",date:input.date,time:input.time,accountId:input.accountId,categoryId,note:"Тест AI",tags:"",version:0,deleted:false };
}

test("automatic entries and category buttons save once and clear task context", async ({page})=>{
  const inputs=[];
  await connected(page,async route=>{
    const input=route.request().postDataJSON();inputs.push(input);
    const clarify=input.text.includes("Мороженое");
    await route.fulfill({json:{text:clarify?"Продукты или кафе?":"Подготовлено",action:clarify?"clarify":"add",entries:[draft(input,clarify?"":undefined)],question:clarify?{text:"Продукты или кафе?",choices:initialState().categories.slice(0,2).map(c=>({label:c.name,categoryId:c.id}))}:undefined}});
  });
  await page.locator("#ai-text").fill("Свинина 200");await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await expect(page.locator(".entry.just-added")).toBeVisible();
  expect(await page.evaluate(async()=>{const db=await import("/db.js");return db.meta("ai-context:"+(await db.meta("settings")).bookId);})).toBeNull();
  await page.getByRole("link",{name:"Помощник",exact:true}).click();
  await page.locator("#ai-text").fill("Мороженое 100");await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await page.locator(".clarification-choices button").first().click();
  await expect(page.locator(".entry.just-added")).toBeVisible();
  expect(inputs).toHaveLength(2);expect(inputs[1].previous).toBeUndefined();
  expect(inputs[0].time).toMatch(/^[0-2]\d:[0-5]\d$/);
  const entries=await page.evaluate(async()=>(await(await import("/db.js")).load()).state.entries);
  expect(entries.map(e=>e.time)).toEqual(inputs.map(i=>i.time));
  expect(await page.evaluate(async()=>(await(await import("/db.js")).load()).state.entries.length)).toBe(2);
});

test("saving an AI task is atomic across tabs and preserves later edits", async ({page,context})=>{
  await page.goto("/");await page.waitForFunction(()=>window.__financeReady);
  const saved=await page.evaluate(async()=>{
    const db=await import("/db.js"),s=await db.meta("settings"),m=await import("/model.js"),state=m.initialState();
    const input={id:crypto.randomUUID(),taskId:crypto.randomUUID(),text:"Тест",mode:"auto",date:m.today(),accountId:state.accounts[0].id};
    const entry={id:crypto.randomUUID(),amount:"200.00",kind:"expense",date:input.date,accountId:input.accountId,categoryId:state.categories[0].id,note:"Тест",tags:""};
    const item={bookId:s.bookId,input};await db.enqueueAI(item);await db.completeAI(item,{text:"Готово",entries:[entry],action:"add"});
    return {id:input.id,book:s.bookId,entry};
  });
  const second=await context.newPage();await second.goto("/");await second.waitForFunction(()=>window.__financeReady);
  const save=(tab)=>tab.evaluate(async x=>(await import("/db.js")).saveAssistant(x.id,x.book,[x.entry]),saved);
  await Promise.all([save(page),save(second)]);
  await page.evaluate(async x=>{const db=await import("/db.js");await db.save("entry",{...x.entry,note:"Изменено"},x.book);},saved);
  await save(second);
  const result=await page.evaluate(async()=>{const db=await import("/db.js"),s=await db.load();return {entries:s.state.entries,context:await db.meta("ai-context:"+s.settings.bookId),saved:(await db.meta("ai-results"))[0].saved};});
  expect(result.entries).toHaveLength(1);expect(result.entries[0].note).toBe("Изменено");expect(result.context).toBeNull();expect(result.saved).toBe(true);
});

test("background AI completion keeps an open form and offers navigation",async({page})=>{
  let release;
  await connected(page,async route=>{const input=route.request().postDataJSON();await new Promise(resolve=>release=resolve);await route.fulfill({json:{text:"Подготовлено",action:"add",entries:[draft(input)]}});});
  await page.locator("#ai-text").fill("Свинина 200");await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await expect.poll(()=>!!release).toBe(true);
  await page.getByRole("link",{name:"Обзор",exact:true}).click();await page.getByRole("button",{name:"Добавить",exact:true}).click();
  await page.getByRole("textbox",{name:"Сумма",exact:true}).fill("7");release();
  await expect(page.locator("#toast")).toContainText("Добавлено операций");
  await expect(page.getByRole("textbox",{name:"Сумма",exact:true})).toHaveValue("7");
  await page.getByRole("button",{name:"Закрыть",exact:true}).click();await page.locator("#toast").getByRole("button",{name:"Показать"}).click();
  await expect(page.locator(".entry.just-added")).toBeVisible();
});

test("receipt totals display USD, preserve legacy RUB and hide ambiguous currencies", async ({page}) => {
  await connected(page, async route => {
    const input = route.request().postDataJSON();
    const entries = [{...draft(input), currency: ["USD", "mixed", "unspecified"].includes(input.text) ? "USD" : input.text === "unknown" ? "XYZ" : ""}];
    if (input.text === "mixed") entries.push({...draft(input), currency:"RUB"});
    await route.fulfill({json:{text:`Чек ${input.text}`, action:"review", receipt:true, total:"200.00", ...(["USD", "mixed"].includes(input.text) ? {receiptCurrency:"USD"} : input.text === "unknown" ? {receiptCurrency:"XYZ"} : {}), entries}});
  });
  for (const type of ["USD", "legacy", "mixed", "unspecified", "unknown"]) {
    await page.locator("#ai-text").fill(type);
    await page.getByRole("button", {name:"Отправить", exact:true}).click();
    const result = page.locator(".assistant-result").filter({hasText:`Чек ${type}`});
    await expect(result).toBeVisible();
    if (type === "USD") { await expect(result).toContainText(/итог чека.*(?:USD|\$)/); await expect(result).not.toContainText("₽"); }
    if (type === "legacy") await expect(result).toContainText(/итог чека.*₽/);
    if (["mixed", "unspecified", "unknown"].includes(type)) await expect(result).not.toContainText("итог чека");
  }
});

test("a receipt always waits for review even when the provider suggests auto-add",async({page})=>{
  await connected(page,async route=>{const input=route.request().postDataJSON();await route.fulfill({json:{text:"Чек",action:"add",entries:[draft(input)],total:"200.00"}});});
  await page.evaluate(async()=>{
    const db=await import("/db.js"),s=await db.meta("settings"),model=await import("/model.js");
    await db.enqueueAI({bookId:s.bookId,input:{id:crypto.randomUUID(),taskId:crypto.randomUUID(),mode:"auto",text:"Чек",image:"fixture",date:model.today(),accountId:model.initialState().accounts[0].id}});
    window.dispatchEvent(new Event("online"));
  });
  await page.getByRole("button",{name:/Прежняя переписка/}).click();
  await expect(page.getByRole("button",{name:"Проверить и сохранить",exact:true})).toBeVisible();
  expect(await page.evaluate(async()=>(await(await import("/db.js")).load()).state.entries.length)).toBe(0);
  await page.getByRole("button",{name:"Проверить и сохранить",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Проверка чека",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Сохранить (1)",exact:true}).click();
  await expect(page.locator(".entry.just-added")).toBeVisible();
});

test("independent statistics requests keep visible history without an automatic model context",async({page})=>{
  const inputs=[];
  await connected(page,async route=>{inputs.push(route.request().postDataJSON());await route.fulfill({json:{text:"Статистика",action:"answer",entries:[]}});});
  const send=async text=>{const count=inputs.length+1;await page.locator("#ai-text").fill(text);await page.getByRole("button",{name:"Отправить",exact:true}).click();await expect.poll(()=>inputs.length).toBe(count);await expect(page.locator(".assistant-result:not(.ai-queued)")).toHaveCount(count);};
  await send("Расходы за месяц");
  expect(await page.evaluate(async()=>{const db=await import("/db.js");return db.meta("ai-context:"+(await db.meta("settings")).bookId);})).toBeNull();
  await send("А за неделю?");
  expect(inputs[1].previous).toBeUndefined();
  await send("Доходы за год");await send("Расходы за день");
  expect(inputs.every(input=>input.previous===undefined&&input.pendingTaskId===undefined)).toBe(true);
  expect(new Set(inputs.map(input=>input.taskId)).size).toBe(4);
  await expect(page.locator(".chat-message")).toHaveCount(8);
});

test("entering the assistant from a new operation starts a new task",async({page})=>{
  const inputs=[];
  await connected(page,async route=>{inputs.push(route.request().postDataJSON());await route.fulfill({json:{text:"Статистика",action:"answer",entries:[]}});});
  await page.locator("#ai-text").fill("Расходы за год");await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await expect(page.locator(".assistant-result:not(.ai-queued)")).toHaveCount(1);
  await page.getByRole("link",{name:"Обзор",exact:true}).click();await page.getByRole("button",{name:"Добавить",exact:true}).click();
  await page.getByRole("textbox",{name:"Сумма",exact:true}).fill("37");
  await page.getByRole("button",{name:"Добавить через помощника",exact:true}).click();
  await expect(page.locator("#ai-text")).toContainText("37");
  await page.getByRole("button",{name:"Отправить",exact:true}).click();await expect.poll(()=>inputs.length).toBe(2);
  expect(inputs[1].previous).toBeUndefined();expect(inputs[1].taskId).not.toBe(inputs[0].taskId);
  await expect(page.locator(".chat-message")).toHaveCount(4);
});

test("an invalid automatic proposal falls back to review without endless retries",async({page})=>{
  let calls=0;
  await connected(page,async route=>{calls++;const input=route.request().postDataJSON();await route.fulfill({json:{text:"Подготовлено",action:"add",entries:[draft(input,"00000000-0000-4000-8000-000000000000")]}});});
  await page.locator("#ai-text").fill("Расход 200");await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await expect(page.getByRole("button",{name:"Проверить и сохранить",exact:true})).toBeVisible();
  const result=await page.evaluate(async()=>{const db=await import("/db.js");return {action:(await db.meta("ai-results"))[0].result.action,entries:(await db.load()).state.entries.length};});
  expect(result).toEqual({action:"review",entries:0});
  await page.evaluate(()=>window.dispatchEvent(new Event("online")));expect(calls).toBe(1);
});

test("legacy queues retain their bounded local history and unfinished drafts",async({page})=>{
  await page.goto("/");await page.waitForFunction(()=>window.__financeReady);
  const counts=await page.evaluate(async()=>{
    const db=await import("/db.js"),s=await db.meta("settings");let first;
    for(let i=0;i<22;i++) {
      const item={bookId:s.bookId,input:{id:crypto.randomUUID(),taskId:crypto.randomUUID(),text:"Task "+i,audio:"AAAA"}};
      if(!i)first=item.input.id;
      await db.enqueueAI(item);await db.completeAI(item,{text:"Result",entries:i?[]:[{id:crypto.randomUUID()}],action:i?"answer":"review"});
    }
    const results=await db.meta("ai-results");return {tasks:results.length,voices:results.filter(x=>x.audio).length,draft:results.some(x=>x.id===first)};
  });
  expect(counts).toEqual({tasks:21,voices:20,draft:true});
});


test("queued assistant time survives reload, backup and clarification",async({page,context})=>{
 const inputs=[];
 await connected(page,async route=>{const input=route.request().postDataJSON();inputs.push(input);await route.fulfill({json:{text:"Уточните",action:"clarify",question:{text:"Уточните",choices:[]},entries:[]}});});
 await context.setOffline(true);
 await page.locator("#ai-text").fill("Продукты 200");await page.getByRole("button",{name:"Отправить",exact:true}).click();
 await expect(page.locator(".ai-queued")).toHaveCount(1);
 const first=await page.evaluate(async()=>{const db=await import('/db.js'),b=await db.backup();await db.restore(b);return (await db.meta('ai-queue'))[0].input;});
 expect(first.time).toMatch(/^[0-2]\d:[0-5]\d$/);
 await page.evaluate(async()=>{const db=await import('/db.js');await db.setMeta('settings',{...await db.meta('settings'),connected:false});window.dispatchEvent(new Event('finance-updated'));});
 await expect(page.locator('.status')).toContainText('Локальный учет');
 await context.setOffline(false);
 await page.reload();await page.waitForFunction(()=>window.__financeReady);
 expect(await page.evaluate(async()=>(await(await import('/db.js')).meta('ai-queue'))[0].input.time)).toBe(first.time);
 await page.evaluate(async()=>{const db=await import('/db.js');await db.setMeta('settings',{...await db.meta('settings'),connected:true});});
 await page.reload();await page.waitForFunction(()=>window.__financeReady);
 await expect.poll(()=>inputs.length).toBe(1);expect(inputs[0].time).toBe(first.time);
 await expect(page.locator(".assistant-result:not(.ai-queued)")).toHaveCount(1);
 await page.locator("#ai-text").fill("Это продукты");await page.getByRole("button",{name:"Отправить",exact:true}).click();
 await expect.poll(()=>inputs.length).toBe(2);expect(inputs[1].time).toBe(first.time);expect(inputs[1].taskId).toBe(first.taskId);
});
