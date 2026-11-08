import {test,expect} from '@playwright/test';
import {connectedChat,send} from './helpers/chat.js';
import {initialState,derivedID} from '../../backend/web/model.js';
test.use({serviceWorkers:'block'});

async function proposal(input,{expense=false,receipt=false,existing=false}={}){
  const category={id:await derivedID(input.taskId,99),name:existing?'Продукты':'Музыка',kind:'expense',...(existing?{existingId:initialState().categories[0].id}:{})};
  const entries=[];
  for(let i=0;i<(receipt?2:expense?1:0);i++)entries.push({id:await derivedID(input.taskId,i),kind:'expense',amount:i?'100.00':'200.00',date:input.date,time:input.time,accountId:input.accountId,categoryId:category.id,note:'Ноты',tags:'',version:0,deleted:false});
  return {text:existing?'Такая категория уже есть':'Выберите оформление',action:'category',category,entries,receipt,...(receipt?{total:'300.00'}:{})};
}
async function styles(page,{fail=false,delay}={}){
  const inputs=[];
  await page.route('**/category-style',async route=>{
    const input=route.request().postDataJSON();inputs.push(input);
    if(delay)await delay(input,inputs.length);
    return route.fulfill(fail?{status:502,json:{error:'Подбор временно недоступен'}}:{json:{suggestions:input.icons.slice(0,3).map((v,i)=>({icon:v.id,color:input.colors[i]}))}});
  });return inputs;
}

test('category styles are proposals until Create, then category and expense save together',async({page})=>{
  const {inputs}=await connectedChat(page,input=>proposal(input,{expense:true})),styleInputs=await styles(page);
  await send(page,inputs,'Ноты 200 рублей, новая категория Музыка');
  await expect(page.locator('.category-style-choice')).toHaveCount(3);
  expect(await page.evaluate(async()=>(await(await import('/db.js')).load()).state.entries.length)).toBe(0);
  await page.locator('.category-style-choice').nth(1).click();await page.getByRole('button',{name:'Создать',exact:true}).click();
  await expect(page.locator('.entry.just-added')).toBeVisible();
  const state=await page.evaluate(async()=>(await(await import('/db.js')).load()).state),category=state.categories.find(c=>c.name==='Музыка');
  expect(category.icon).toBe(styleInputs[0].icons[1].id);expect(category.color).toBe(styleInputs[0].colors[1]);
  expect(state.entries).toHaveLength(1);expect(state.entries[0].categoryId).toBe(category.id);expect(inputs).toHaveLength(1);expect(styleInputs).toHaveLength(1);
});

test('an existing category is reused without changing its style or creating duplicates',async({page})=>{
  const {inputs}=await connectedChat(page,input=>proposal(input,{existing:true})),styleInputs=await styles(page);
  await send(page,inputs,'Добавь категорию Продукты');await expect(page.locator('.chat-category')).toContainText('Категория уже есть');
  await page.getByRole('button',{name:'Использовать',exact:true}).click();await expect(page.locator('.assistant-result')).toContainText('Категория подтверждена');
  const state=await page.evaluate(async()=>(await(await import('/db.js')).load()).state);
  expect(state.categories).toHaveLength(initialState().categories.length);expect(state.categories[0]).toEqual(initialState().categories[0]);expect(styleInputs).toHaveLength(0);
});

test('a style failure offers manual selection and saves only after explicit creation',async({page})=>{
  const {inputs}=await connectedChat(page,input=>proposal(input)),calls=await styles(page,{fail:true});
  await send(page,inputs,'Добавь категорию Музыка');await expect(page.locator('#toast')).toContainText('Подбор временно недоступен');
  await page.getByRole('button',{name:'Выбрать вручную',exact:true}).click();await expect(page.getByRole('heading',{name:'Оформление категории',exact:true})).toBeVisible();
  await page.locator('#icon-search').fill('music');await page.locator('[data-icon="music"]').click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
  expect(await page.evaluate(async()=>(await(await import('/db.js')).load()).state.categories.some(c=>c.name==='Музыка'))).toBe(false);
  await page.getByRole('button',{name:'Создать',exact:true}).click();await expect(page.locator('.assistant-result')).toContainText('Категория подтверждена');
  expect(await page.evaluate(async()=>(await(await import('/db.js')).load()).state.categories.find(c=>c.name==='Музыка').icon)).toBe('music');expect(calls).toHaveLength(1);
});

test('a renamed category ignores stale style suggestions and type remains editable',async({page})=>{
  let release;const {inputs}=await connectedChat(page,input=>proposal(input));
  const calls=await styles(page,{delay:async(_,count)=>{if(count===1)await new Promise(resolve=>{release=resolve;});}});
  await send(page,inputs,'Добавь категорию Музыка');await expect.poll(()=>!!release).toBe(true);
  await page.locator('[data-category-field="name"]').fill('Подарки семье');await page.locator('[data-category-field="kind"]').selectOption('income');release();
  await expect(page.getByRole('button',{name:'Подобрать с ИИ',exact:true})).toBeEnabled();expect(await page.locator('.category-style-choice').count()).toBe(0);
  await page.getByRole('button',{name:'Подобрать с ИИ',exact:true}).click();await expect(page.locator('.category-style-choice')).toHaveCount(3);
  expect(calls[1].name).toBe('Подарки семье');expect(calls[1].kind).toBe('income');
  await page.getByRole('button',{name:'Создать',exact:true}).click();
  await expect(page.locator('.assistant-result')).toContainText('Категория подтверждена');
  expect(await page.evaluate(async()=>(await(await import('/db.js')).load()).state.categories.find(c=>c.name==='Подарки семье').kind)).toBe('income');expect(inputs).toHaveLength(1);
});

test('a receipt with a proposed category waits for line review before creating either record',async({page})=>{
  const {inputs}=await connectedChat(page,input=>proposal(input,{receipt:true}));await styles(page);
  await page.evaluate(async()=>{
    const db=await import('/db.js'),chat=await import('/chat-db.js'),model=await import('/model.js'),s=await db.meta('settings');
    const input={id:crypto.randomUUID(),taskId:crypto.randomUUID(),mode:'auto',contextMode:'explicit',chatEpoch:0,sentAt:new Date().toISOString(),text:'Чек, нужна категория Музыка',image:'fixture',date:model.today(),time:'16:17',accountId:model.initialState().accounts[0].id};
    await chat.enqueue({input,bookId:s.bookId,ownerId:s.userId,createdAt:Date.now()});window.dispatchEvent(new Event('online'));
  });
  await expect(page.locator('.category-style-choice')).toHaveCount(3);await page.getByRole('button',{name:'Проверить чек и создать',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Проверка чека',exact:true})).toBeVisible();
  let state=await page.evaluate(async()=>(await(await import('/db.js')).load()).state);expect(state.entries).toHaveLength(0);expect(state.categories).toHaveLength(initialState().categories.length);
  await page.getByRole('button',{name:'Создать категорию и сохранить (2)',exact:true}).click();await expect(page.locator('.entry.just-added')).toHaveCount(2);
  state=await page.evaluate(async()=>(await(await import('/db.js')).load()).state);expect(state.entries).toHaveLength(2);expect(state.categories).toHaveLength(initialState().categories.length+1);expect(inputs).toHaveLength(1);
});

test('reading a historical category proposal does not spend AI budget automatically',async({page})=>{
  const server=await connectedChat(page),calls=await styles(page),taskId=crypto.randomUUID(),requestId=crypto.randomUUID(),output=await proposal({taskId,date:'2026-11-03',time:'12:00',accountId:initialState().accounts[0].id});
  server.seed([{id:requestId,taskId,role:'user',text:'Музыка',createdAt:new Date(Date.now()-60000).toISOString(),status:'open',deleted:false},{id:await derivedID(requestId,100),taskId,role:'assistant',replyTo:requestId,text:output.text,result:output,createdAt:new Date(Date.now()-59000).toISOString(),status:'open',deleted:false}]);
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('.chat-category')).toHaveCount(1);
  expect(calls).toHaveLength(0);await page.getByRole('button',{name:'Подобрать с ИИ',exact:true}).click();await expect(page.locator('.category-style-choice')).toHaveCount(3);expect(calls).toHaveLength(1);
});

test('a rejected atomic category group returns to review without repeating the model',async({page})=>{
  const {inputs}=await connectedChat(page,input=>proposal(input,{expense:true}));await styles(page);let attempts=0;
  await page.route('**/assistant-tasks/*/apply',async route=>{if(++attempts===1)return route.fulfill({status:400,json:{error:'Категория изменилась. Проверьте оформление'}});return route.fallback();});
  await send(page,inputs,'Ноты 200, категория Музыка');await expect(page.locator('.category-style-choice')).toHaveCount(3);
  await page.getByRole('button',{name:'Создать',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Операции',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Помощник',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('Категория изменилась');
  await expect(page.locator('.chat-category')).toBeVisible();
  expect(await page.evaluate(async()=>(await(await import('/db.js')).load()).state.entries.length)).toBe(0);
  await page.getByRole('button',{name:'Создать',exact:true}).click();await expect(page.locator('.entry.just-added')).toBeVisible();
  expect(inputs).toHaveLength(1);await expect.poll(()=>attempts).toBe(2);
});

test('category cards fit small screens and keep edited names across refresh',async({page})=>{
  const {inputs}=await connectedChat(page,input=>proposal(input));await styles(page);
  await send(page,inputs,'Категория Музыка');await expect(page.locator('.category-style-choice')).toHaveCount(3);
  const name='Длинное название новой категории для семейных расходов';
  await page.locator('[data-category-field="name"]').fill(name);
  await page.evaluate(()=>window.dispatchEvent(new Event('finance-updated')));
  await expect(page.locator('[data-category-field="name"]')).toHaveValue(name);
  for(const width of [320,360,393,430]){
    await page.setViewportSize({width,height:852});
    expect(await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,card:document.querySelector('.chat-category').scrollWidth>document.querySelector('.chat-category').clientWidth}))).toEqual({overflow:false,card:false});
  }
});
