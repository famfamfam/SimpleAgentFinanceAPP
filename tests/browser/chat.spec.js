import {fakeRecorder} from "./helpers/voice.js";
import { test, expect } from "@playwright/test";
import {connectedChat,send} from "./helpers/chat.js";
test.use({serviceWorkers:"block"});

test("independent requests use quotes and explicit unfinished context only",async({page})=>{
  const {inputs}=await connectedChat(page,async input=>input.text==="Уточни"?{text:"Какая сумма?",action:"clarify",entries:[],question:{text:"Какая сумма?",choices:[]}}:{text:"Ответ: "+input.text,action:"answer",entries:[]});
  await send(page,inputs,"Первый вопрос");await send(page,inputs,"Второй вопрос");
  expect(inputs[1].previous).toBeUndefined();expect(inputs[1].pendingTaskId).toBeUndefined();expect(inputs[1].quoteIds).toBeUndefined();
  const user=page.locator('.chat-user').filter({hasText:"Первый вопрос"});
  await user.getByRole('button',{name:'Действия с сообщением',exact:true}).click();await page.getByRole('button',{name:'Цитировать',exact:true}).click();
  await expect(page.locator('.composer-quote')).toContainText('Первый вопрос');
  await send(page,inputs,"Сравни");expect(inputs[2].quoteIds).toEqual([inputs[0].id]);expect(inputs[2].previous).toBeUndefined();
  await expect(page.locator('.composer-quote')).toHaveCount(0);
  await send(page,inputs,"Уточни");await expect(page.locator('.pending-context')).toContainText('Ответ на уточнение');
  await send(page,inputs,"100 рублей");expect(inputs[4].pendingTaskId).toBe(inputs[3].taskId);expect(inputs[4].taskId).toBe(inputs[3].taskId);
  await send(page,inputs,"Уточни");await page.getByRole('button',{name:'Начать независимый запрос',exact:true}).click();
  await send(page,inputs,"Новый вопрос");expect(inputs[6].pendingTaskId).toBeUndefined();expect(inputs[6].taskId).not.toBe(inputs[5].taskId);
  await expect(page.locator('.chat-date')).toHaveCount(1);await expect(page.locator('.chat-message .message-meta time')).toHaveCount(14);
});

test("send stops recording once, keeps WAV outside metadata and shows the transcript",async({page,context,browserName})=>{
  const {inputs}=await connectedChat(page,async()=>({text:"Готово",entries:[],action:"answer",transcript:"Продукты двести рублей"}));
  const offline=async value=>{
    // shortcut: Windows WebKit's offline emulator blocks Blob I/O; verify real airplane mode on an iPhone.
    if(browserName==='webkit')await page.evaluate(value=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>!value});window.dispatchEvent(new Event(value?'offline':'online'));},value);
    else await context.setOffline(value);
  };
  await fakeRecorder(page);await offline(true);
  await page.getByRole('button',{name:'Записать голос',exact:true}).click();
  await page.getByRole('button',{name:'Отправить',exact:true}).click();
  await expect(page.locator('.ai-queued')).toContainText('В очереди');
  const queued=await page.evaluate(async()=>{
    const db=await import('/db.js'),chat=await import('/chat-db.js'),item=(await db.meta('ai-queue'))[0],media=await chat.media(await db.meta('settings'),item.input.id);
    const b=await db.backup();await db.restore(b);
    return {id:item.input.id,sentAt:item.input.sentAt,hasAudio:item.hasAudio,inline:item.input.audio,wav:media.wav.size,original:media.blob.size,stopped:window.trackStopped,count:window.stopCount};
  });
  expect(queued).toMatchObject({hasAudio:true,inline:undefined,wav:32044,original:32044,stopped:true,count:1});
  expect(inputs).toHaveLength(0);
  await offline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(page.locator('.voice-transcript')).toHaveText('Продукты двести рублей');
  expect(inputs).toHaveLength(1);expect(inputs[0].id).toBe(queued.id);expect(inputs[0].sentAt).toBe(queued.sentAt);expect(inputs[0].audio.length).toBeGreaterThan(32000);
  await page.getByRole('button',{name:'Прослушать голосовое сообщение',exact:true}).click();await expect(page.locator('.chat-user audio')).toHaveCount(1);
  const stored=await page.evaluate(async()=>{const db=await import('/db.js'),chat=await import('/chat-db.js'),s=await db.meta('settings'),rows=await chat.messages(s);const m=await chat.media(s,rows.messages.find(m=>m.role==='user').id);return {wav:!!m.wav,metadata:JSON.stringify(await db.meta('ai-results')).includes('UklGR'),messages:rows.messages.length};});
  expect(stored).toEqual({wav:false,metadata:false,messages:2});
});

test("deleting a pending request cancels a late reply and keeps saved financial data",async({page})=>{
  let resolve;const wait=new Promise(r=>{resolve=r;});
  const {inputs}=await connectedChat(page,async()=>{await wait;return {text:'Поздний ответ',action:'answer',entries:[]};});
  await page.locator('#ai-text').fill('Долгий вопрос');await page.getByRole('button',{name:'Отправить',exact:true}).click();await expect.poll(()=>inputs.length).toBe(1);
  await page.locator('.chat-user').getByRole('button',{name:'Действия с сообщением',exact:true}).click();await page.getByRole('button',{name:'Удалить',exact:true}).click();
  await page.locator('#modal').getByRole('button',{name:'Удалить',exact:true}).click();await expect(page.locator('.chat-message')).toHaveCount(0);
  resolve();await expect.poll(()=>page.evaluate(async()=>((await(await import('/db.js')).meta('ai-queue')) || []).length)).toBe(0);
  await expect(page.locator('.chat-message')).toHaveCount(0);
  expect(await page.evaluate(async()=>(await(await import('/db.js')).load()).state.entries.length)).toBe(0);
});

test("local task groups are atomic and an old backup cannot resurrect a deleted task",async({page})=>{
  await connectedChat(page);
  const result=await page.evaluate(async()=>{
    const db=await import('/db.js'),chat=await import('/chat-db.js'),model=await import('/model.js');
    const s=await db.meta('settings');await db.setMeta('settings',{...s,connected:false});
    const input={id:crypto.randomUUID(),taskId:crypto.randomUUID(),text:'Продукты 200',mode:'auto',contextMode:'explicit',date:model.today(),time:'14:25',sentAt:new Date().toISOString(),chatEpoch:0,accountId:model.initialState().accounts[0].id};
    const item={input,ownerId:s.userId,scope:chat.scopeOf(s),bookId:s.bookId,createdAt:Date.now()};
    await chat.enqueue(item);const entry={id:await model.derivedID(input.taskId,0),kind:'expense',amount:'200.00',date:input.date,time:input.time,accountId:input.accountId,categoryId:model.initialState().categories[0].id,note:'Тест',tags:'',version:0,deleted:false};
    await chat.complete(item,{text:'Подготовлено',action:'add',entries:[entry]});
    const saved=await Promise.all([db.saveAssistant(input.id,s.bookId,[entry]),db.saveAssistant(input.id,s.bookId,[entry])]);
    const batch=await db.prepareBatch(s.bookId),backup=await db.backup();
    await chat.remove(s,[input.id]);await db.restore(backup);
    const after=await db.load(),messages=await chat.messages(s);
    return {once:saved.filter(x=>!x.alreadyApplied).length,group:batch.taskId,commands:batch.commands.length,restoredEntries:after.state.entries.length,visible:messages.messages.filter(m=>m.role==='user').length,groups:(await db.meta('ai-groups')).length};
  });
  expect(result).toMatchObject({once:1,commands:1,restoredEntries:0,visible:0,groups:0});expect(result.group).toMatch(/^[0-9a-f-]{36}$/);
});

test("quote limits count UTF-8 bytes and recoverable cache eviction protects pending voice",async({page})=>{
  await connectedChat(page);
  const result=await page.evaluate(async()=>{
    const chat=await import('/chat-db.js'),db=await import('/db.js'),s=await db.meta('settings'),scope=chat.scopeOf(s),id=crypto.randomUUID();
    const errors=[];for(const rows of [[{text:'я'.repeat(4097)}],[{text:''}],[1,2,3,4].map(n=>({text:String(n)}))])try{chat.checkQuotes(rows);}catch(e){errors.push(e.message);}
    const pending={key:chat.messageKey(scope,id),id,scope,ownerId:s.userId,bookId:s.bookId,createdAt:new Date().toISOString(),processed:false,uploaded:false,wav:await chat.packedAudio(new Blob(['wav'])),blob:await chat.packedAudio(new Blob(['original']))};
    const cached={...pending,key:chat.messageKey(scope,crypto.randomUUID()),processed:true,uploaded:true,wav:undefined};
    await db.transaction(['media'],tx=>{tx.objectStore('media').put(pending);tx.objectStore('media').put(cached);});
    let attempts=0;await chat.withQuotaRetry(async()=>{if(++attempts===1)throw new DOMException('full','QuotaExceededError');});
    const database=await db.openDB(),rows=await db.request(database.transaction('media').objectStore('media').getAll());
    return {errors:errors.length,attempts,pending:rows.find(m=>m.key===pending.key).wav.size,cache:!!rows.find(m=>m.key===cached.key).blob};
  });
  expect(result).toEqual({errors:3,attempts:2,pending:3,cache:false});
});

test("long history renders fifty messages and loads earlier messages on demand",async({page})=>{
  const server=await connectedChat(page),rows=[];
  for(let i=0;i<125;i++)rows.push({id:crypto.randomUUID(),taskId:crypto.randomUUID(),role:'user',text:'История '+i,createdAt:new Date(Date.now()-i*60000).toISOString(),status:'open',deleted:false});
  server.seed(rows);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(page.locator('.chat-message')).toHaveCount(50);
  await expect.poll(()=>page.evaluate(async()=>{const chat=await import('/chat-db.js'),db=await import('/db.js');return (await chat.messages(await db.meta('settings'),200)).messages.length;})).toBe(125);
  await page.evaluate(()=>{for(let i=0;i<5;i++)window.dispatchEvent(new Event('finance-updated'));});
  await page.evaluate(()=>{const el=document.querySelector('.chat-messages');el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  await expect(page.locator('.chat-message')).toHaveCount(100);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('history expiry keeps queued financial commands and user deletion still cancels them',async({page})=>{
  await connectedChat(page);
  const result=await page.evaluate(async()=>{
    const db=await import('/db.js'),chat=await import('/chat-db.js'),model=await import('/model.js'),s=await db.meta('settings');
    await db.setMeta('settings',{...s,connected:false});
    const input={id:crypto.randomUUID(),taskId:crypto.randomUUID(),text:'Расход 200',mode:'auto',contextMode:'explicit',date:model.today(),time:'10:20',sentAt:new Date().toISOString(),chatEpoch:0,accountId:model.initialState().accounts[0].id};
    const item={input,scope:chat.scopeOf(s),bookId:s.bookId,ownerId:s.userId,createdAt:Date.now()};
    await chat.enqueue(item);const entry={id:await model.derivedID(input.taskId,0),kind:'expense',amount:'200.00',date:input.date,time:input.time,accountId:input.accountId,categoryId:model.initialState().categories[0].id,note:'Очередь',tags:'',version:0,deleted:false};
    await chat.complete(item,{text:'Подготовлено',action:'add',entries:[entry]});await db.saveAssistant(input.id,s.bookId,[entry]);
    const old=new Date(Date.now()-91*86400000).toISOString();
    await chat.accept(s,{epoch:0,cursor:2,messages:[{id:input.id,taskId:input.taskId,role:'user',text:'',createdAt:old,seq:1,deleted:true,expired:true,status:'open'},{id:await model.derivedID(input.id,100),taskId:input.taskId,role:'assistant',text:'',createdAt:old,seq:2,deleted:true,expired:true,status:'open'}]},{changes:true});
    const backup=await db.backup();await db.restore(backup);let current=await db.load();const retained=current.state.entries.length;
    await chat.remove(s,[],true);
    current=await db.load();return {retained,afterDeletion:current.state.entries.length,groups:(await db.meta('ai-groups')).length};
  });
  expect(result).toEqual({retained:1,afterDeletion:0,groups:0});
});

test('old local voice moves out of metadata and transfers explicitly without executing tasks',async({page})=>{
  const server=await connectedChat(page);
  const original=await page.evaluate(async()=>{
    const db=await import('/db.js'),chat=await import('/chat-db.js'),s=await db.meta('settings'),id=crypto.randomUUID(),taskId=crypto.randomUUID();
    const data=new Uint8Array(64);data[0]=82;
    await db.setMeta('ai-results',[{id,taskId,bookId:s.bookId,createdAt:Date.now(),prompt:'Прежний голос',audio:chat.bufferBase64(data.buffer),result:{text:'Прежний ответ',transcript:'Продукты двести',action:'answer',entries:[]},saved:false}]);
    await chat.migrateLegacyAudio();
    const row=(await db.meta('ai-results'))[0],media=await chat.media({userId:'legacy',bookId:s.bookId},id),backup=await db.backup();
    await db.transaction(['media'],tx=>tx.objectStore('media').clear());await db.restore(backup);
    const restored=await chat.media({userId:'legacy',bookId:s.bookId},id);
    window.dispatchEvent(new Event('finance-updated'));
    return {id,inline:row.audio,key:row.legacyMediaKey,bytes:media.blob.size,restored:restored.blob.size};
  });
  expect(original).toMatchObject({inline:undefined,bytes:64,restored:64});expect(original.key).toContain('legacy:');
  await page.getByRole('button',{name:/Прежняя переписка/}).click();await expect(page.locator('.chat-message')).toHaveCount(2);
  await page.getByRole('button',{name:'Прослушать голосовое сообщение',exact:true}).click();await expect(page.locator('audio')).toHaveCount(1);
  await page.getByRole('button',{name:'Перенести в личную историю',exact:true}).click();await page.getByRole('button',{name:'Перенести',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Помощник',exact:true})).toBeVisible();await expect(page.locator('.voice-transcript')).toContainText('Продукты двести');
  expect(server.inputs).toHaveLength(0);expect(await page.evaluate(async()=>(await(await import('/db.js')).load()).state.entries.length)).toBe(0);
});

test('an expired server attachment stops retrying without removing local playback',async({page})=>{
  await connectedChat(page);let uploads=0;
  await page.route('**/chat/media/*',route=>{uploads++;return route.fulfill({status:410,json:{error:'Срок хранения истёк'}});});
  await page.evaluate(async()=>{
    const db=await import('/db.js'),chat=await import('/chat-db.js'),m=await import('/model.js'),s=await db.meta('settings');
    const input={id:crypto.randomUUID(),taskId:crypto.randomUUID(),text:'Голос',mode:'auto',contextMode:'explicit',sentAt:new Date().toISOString(),chatEpoch:0,date:m.today(),time:'12:00',accountId:m.initialState().accounts[0].id};
    const item={input,scope:chat.scopeOf(s),bookId:s.bookId,ownerId:s.userId,createdAt:Date.now()};
    await chat.enqueue(item,{audio:btoa('voice'),original:new Blob(['voice'],{type:'audio/webm'})});
    await chat.complete(item,{text:'Ответ',action:'answer',entries:[]});window.dispatchEvent(new Event('online'));
  });
  await expect.poll(()=>page.evaluate(async()=>{const db=await import('/db.js'),chat=await import('/chat-db.js'),s=await db.meta('settings');return (await chat.pendingMedia(s)).length;})).toBe(0);
  expect(uploads).toBe(1);
  const size=await page.evaluate(async()=>{const db=await import('/db.js'),chat=await import('/chat-db.js'),s=await db.meta('settings'),rows=await chat.messages(s);return (await chat.media(s,rows.messages.find(m=>m.audio).id)).blob.size;});
  expect(size).toBe(5);
});
