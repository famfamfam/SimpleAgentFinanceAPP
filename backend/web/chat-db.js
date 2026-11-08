import { openDB, request, transaction, meta } from "./db.js";
import { derivedID, bufferBase64, base64Buffer } from "./model.js";
export { bufferBase64 };

export const scopeOf = settings => `${settings.userId || "local"}:${settings.bookId}`;
export const messageKey = (scope, id) => `${scope}:${id}`;
const draftKey = (settings, kind) => `${kind}-draft:${settings.bookId}`;
const privateDraftKey = (settings, kind) => `draft:${scopeOf(settings)}:${kind}`;
const draftOwner = settings => settings.userId || "local";
async function assertDraftScope(store, settings) {
  const latest = (await request(store.get("settings")))?.value;
  if (!latest || latest.bookId !== settings.bookId || latest.userId !== settings.userId) throw Error("Книга или пользователь изменились. Обновите экран");
}
// Keep canonical values readable by rollback clients; ownership lives on the meta row.
export async function preserveDrafts(store, settings) {
  if (!settings?.bookId) return;
  for (const kind of ["ai", "entry"]) {
    const row = await request(store.get(draftKey(settings, kind)));
    if (!row) continue;
    const ownerId = row.ownerId || draftOwner(settings);
    store.put({...row, ownerId});
    store.put({id:privateDraftKey({...settings, userId:ownerId}, kind), value:row.value});
  }
}
export async function draftValue(store, settings, kind = "ai") {
  await assertDraftScope(store, settings);
  const row = await request(store.get(draftKey(settings, kind)));
  if (row && (!row.ownerId || row.ownerId === draftOwner(settings))) {
    if (!row.ownerId) store.put({...row, ownerId:draftOwner(settings)});
    return row.value;
  }
  return (await request(store.get(privateDraftKey(settings, kind))))?.value;
}
export async function putDraft(store, settings, kind, value) {
  await assertDraftScope(store, settings);
  const row = await request(store.get(draftKey(settings, kind)));
  if (row) store.put({id:privateDraftKey({...settings, userId:row.ownerId || draftOwner(settings)}, kind), value:row.value});
  store.put({id:draftKey(settings, kind), ownerId:draftOwner(settings), value});
}
export async function readDraft(settings, kind = "ai") {
  return transaction(["meta"], tx => draftValue(tx.objectStore("meta"), settings, kind));
}
export async function writeDraft(settings, value, kind = "ai") {
  return transaction(["meta"], tx => putDraft(tx.objectStore("meta"), settings, kind, value));
}
// ArrayBuffer also works in WebKit builds that cannot persist structured-cloned Blobs.
export const packedAudio = async blob => ({data:await blob.arrayBuffer(),type:blob.type,size:blob.size});
const audioBlob = value => value instanceof Blob?value:new Blob([value.data],{type:value.type});
const stateKey = scope => "chat:" + scope;
const deleteKey = scope => "chat-delete:" + scope;
const day = 86400000, audioLimit = 100 * 1024 * 1024;
export const quoteText = m => [m.text, m.transcript].filter(x => x?.trim()).join("\n").trim();
export function checkQuotes(messages) {
  if (messages.length > 3) throw Error("Можно выбрать до трёх цитат");
  if (messages.some(m => m.deleted || !quoteText(m))) throw Error("Для цитирования нужен текст или расшифровка");
  if (new TextEncoder().encode(messages.map(quoteText).join("")).length > 8192)
    throw Error("Цитаты занимают больше 8 КБ. Выберите меньше сообщений");
}
export async function state(settings) { return await meta(stateKey(scopeOf(settings))) || { epoch:0, cursor:0 }; }
export async function message(settings, id) {
  const db = await openDB();
  return request(db.transaction("messages").objectStore("messages").get(messageKey(scopeOf(settings),id)));
}
export async function messages(settings, limit = 50, before) {
  const db = await openDB(), scope = scopeOf(settings);
  const range = IDBKeyRange.bound([scope,"",""], [scope,before?.createdAt || "\uffff",before?.id || "\uffff"],false,!!before);
  return new Promise((resolve,reject) => {
    const rows = [], cursor = db.transaction("messages").objectStore("messages").index("scope-created").openCursor(range,"prev");
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || rows.length === limit+1) return resolve({ messages:rows.slice(0,limit).reverse(), more:rows.length>limit });
      if (!c.value.deleted) rows.push(c.value);
      c.continue();
    };
  });
}
export async function media(settings, id) {
  const db = await openDB();
  const row=await request(db.transaction("media").objectStore("media").get(messageKey(scopeOf(settings),id)));
  return row?{...row,...(row.blob?{blob:audioBlob(row.blob)}:{}),...(row.wav?{wav:audioBlob(row.wav)}:{})}:row;
}
export async function mediaStats() {
  const db = await openDB(), rows = await request(db.transaction("media").objectStore("media").getAll());
  return rows.reduce((n,m) => n + (m.blob?.size || 0) + (m.wav?.size || 0),0);
}
let migratingLegacy=false;
export async function migrateLegacyAudio() {
  if(migratingLegacy)return;migratingLegacy=true;
  try {
    for(;;){
      const rows=((await meta("ai-results")) || []).filter(x=>x.contextMode!=="explicit"&&typeof x.audio==="string"&&x.audio.length<=2600000&&x.audio.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(x.audio)).slice(0,3);
      if(!rows.length)break;
      const packed=rows.map(x=>{const data=base64Buffer(x.audio),scope="legacy:"+x.bookId;return {source:x,record:{key:messageKey(scope,x.id),id:x.id,scope,ownerId:"legacy",bookId:x.bookId,legacy:true,createdAt:new Date(x.createdAt || Date.now()).toISOString(),processed:true,uploaded:false,blob:{data,size:data.byteLength,type:"audio/wav"}}};});
      await withQuotaRetry(()=>transaction(["meta","media"],async tx=>{
        const s=tx.objectStore("meta"),results=(await request(s.get("ai-results")))?.value || [];
        const next=results.map(x=>{const match=packed.find(p=>p.source.id===x.id&&p.source.bookId===x.bookId&&p.source.audio===x.audio);if(!match)return x;tx.objectStore("media").put(match.record);return {...x,audio:undefined,legacyMediaKey:match.record.key};});
        s.put({id:"ai-results",value:next});
      }));
    }
  }finally{migratingLegacy=false;}
}
async function evictCache() {
  await transaction(["media","messages"],async tx => {
    const store = tx.objectStore("media"), rows = await request(store.getAll());
    for (const m of rows) if (m.processed && m.uploaded && !m.wav) {
      store.put({ ...m, blob:undefined });
      const s=tx.objectStore("messages"),message=await request(s.get(m.key));if(message)s.put({...message,cachedAudio:false});
    }
  });
}
export async function withQuotaRetry(operation) {
  try { return await operation(); }
  catch (error) {
    if (error?.name !== "QuotaExceededError") throw error;
    await evictCache();
    try { return await operation(); }
    catch (retry) {
      if (retry?.name === "QuotaExceededError") throw Error("Недостаточно места на устройстве. Запись остаётся в предпросмотре; освободите место и повторите");
      throw retry;
    }
  }
}
export function audioBase64(blob) {
  return blob.arrayBuffer().then(bufferBase64);
}
export function base64Blob(audio, type="audio/wav") {
  return new Blob([base64Buffer(audio)],{type});
}
export async function enqueue(item, attachment) {
  const hasAudio=!!attachment?.audio;
  const data=hasAudio?base64Buffer(attachment.audio):null;
  const wav=hasAudio?{data,type:"audio/wav",size:data.byteLength}:null;
  const original=hasAudio?(attachment.original?await packedAudio(attachment.original):wav):null;
  return withQuotaRetry(() => transaction(["meta","messages","media"],async tx => {
    const store=tx.objectStore("meta"), settings=(await request(store.get("settings"))).value;
    if(settings.bookId!==item.bookId || settings.userId!==item.ownerId)throw Error("Книга или пользователь изменились. Отправьте запрос заново");
    const scope=scopeOf(settings), queue=(await request(store.get("ai-queue")))?.value || [];
    if(queue.filter(x=>x.bookId===item.bookId && (!x.ownerId || x.ownerId===item.ownerId)).length>=5)throw Error("В очереди уже пять запросов. Дождитесь ответа или уберите лишние");
    const head=(await request(store.get(stateKey(scope))))?.value || {epoch:0,cursor:0};
    if(item.input.chatEpoch!==head.epoch)throw Error("Переписка изменилась. Повторите отправку");
    const id=item.input.id,key=messageKey(scope,id);
    if(hasAudio)tx.objectStore("media").put({key,id,scope,ownerId:item.ownerId,bookId:item.bookId,blob:original,wav,processed:false,uploaded:false,createdAt:item.input.sentAt});
    const input={...item.input};delete input.audio;
    queue.push({...item,input,scope,hasAudio});
    store.put({id:"ai-queue",value:queue});
    await putDraft(store, settings, "ai", "");
    store.put({id:"ai-active:"+scope,value:input.taskId});
    tx.objectStore("messages").put({key,id,scope,taskId:input.taskId,role:"user",text:input.text || (input.image?"Фото чека":""),createdAt:input.sentAt,epoch:input.chatEpoch,seq:0,status:"queued",audio:hasAudio,cachedAudio:hasAudio});
  }));
}
export async function inputFor(item) {
  if(!item.hasAudio)return item.input;
  const db=await openDB(), record=await request(db.transaction("media").objectStore("media").get(messageKey(item.scope,item.input.id)));
  if(!record?.wav)throw Error("Не найдена запись для отправки. Восстановите локальную копию или запишите сообщение заново");
  return {...item.input,audio:record.wav.data?bufferBase64(record.wav.data):await audioBase64(record.wav)};
}
export async function complete(item, response) {
  const replyId=response.messageId || await derivedID(item.input.id,100);
  return withQuotaRetry(() => transaction(["meta","messages","media"],async tx => {
    const store=tx.objectStore("meta"), queue=(await request(store.get("ai-queue")))?.value || [];
    const results=(await request(store.get("ai-results")))?.value || [];
    if(!queue.some(x=>x.input.id===item.input.id && x.scope===item.scope))return results;
    const head=(await request(store.get(stateKey(item.scope))))?.value || {epoch:0};
    const messages=tx.objectStore("messages"), user=await request(messages.get(messageKey(item.scope,item.input.id)));
    if(!user || user.deleted || head.epoch!==item.input.chatEpoch)return results;
    const saved={id:item.input.id,taskId:item.input.taskId,bookId:item.bookId,ownerId:item.ownerId,scope:item.scope,contextMode:"explicit",result:response,prompt:item.input.text,createdAt:item.createdAt,saved:false,entryDraftId:item.entryDraftId,categoryStylePending:!!response.category};
    const prior=results.find(x=>x.id===item.input.id && x.scope===item.scope);
    if(!prior)results.push(saved);
    const kept=[...results.filter(x=>x.contextMode!=="explicit"),...results.filter(x=>x.contextMode==="explicit").slice(-20)];
    store.put({id:"ai-results",value:kept});
    store.put({id:"ai-queue",value:queue.filter(x=>x.input.id!==item.input.id || x.scope!==item.scope)});
    messages.put({...user,transcript:response.transcript || "",status:"open"});
    const result={...response};delete result.transcript;
    const replyKey=messageKey(item.scope,replyId),existing=await request(messages.get(replyKey));
    if(!existing?.deleted)messages.put({key:replyKey,id:replyId,scope:item.scope,taskId:item.input.taskId,role:"assistant",text:response.text,result,replyTo:item.input.id,createdAt:response.completedAt || new Date().toISOString(),seq:existing?.seq || 0,status:"open"});
    const attachment=await request(tx.objectStore("media").get(user.key));
    if(attachment){
      tx.objectStore("media").put({...attachment,wav:undefined,processed:true});
      const key="chat-upload:"+item.scope,ids=(await request(store.get(key)))?.value || [];
      store.put({id:key,value:[...new Set([...ids,item.input.id])]});
    }
    const contextKey="ai-context:"+item.bookId, active=(await request(store.get(contextKey)))?.value;
    if((await request(store.get("ai-active:"+item.scope)))?.value===item.input.taskId)store.put({id:contextKey,value:["clarify","review","category"].includes(response.action)?{
      taskId:item.input.taskId,requestId:item.input.id,userId:item.ownerId,updatedAt:Date.now(),previous:[],pending:true,
      date:item.input.date,time:item.input.time,accountId:item.input.accountId,receipt:!!item.input.image || item.receipt,
    }:null});
    return kept;
  }));
}
function cancelLocal(tx, store, scope, tasks) {
  if(!tasks.size)return Promise.resolve(false);
  // Group commands haven't reached the server yet. Applied records live in the base snapshot.
  return Promise.all([request(tx.objectStore("outbox").getAll()),request(store.get("ai-queue")),request(store.get("ai-results"))]).then(async ([commands,q,r])=>{
    const removed=new Set(commands.filter(c=>c.scope===scope&&tasks.has(c.taskId)).map(c=>c.id));
    let grew=true;while(grew){grew=false;for(const c of commands)if(removed.has(c.depends)&&!removed.has(c.id)){removed.add(c.id);grew=true;}}
    for(const id of removed)tx.objectStore("outbox").delete(id);
    store.put({id:"ai-queue",value:(q?.value || []).filter(x=>x.scope!==scope || !tasks.has(x.input.taskId))});
    store.put({id:"ai-results",value:(r?.value || []).map(x=>x.scope===scope&&tasks.has(x.taskId)?{...x,cancelled:true}:x)});
    const groups=(await request(store.get("ai-groups")))?.value || [];
    store.put({id:"ai-groups",value:groups.filter(x=>x.scope!==scope||!tasks.has(x.taskId))});
    const bookId=scope.slice(scope.indexOf(":")+1),key="ai-context:"+bookId;
    if(tasks.has((await request(store.get(key)))?.value?.taskId))store.put({id:key,value:null});
    if(tasks.has((await request(store.get("ai-active:"+scope)))?.value))store.put({id:"ai-active:"+scope,value:null});
    const messages=await request(tx.objectStore("messages").index("scope").getAll(scope));
    const stopped=messages.filter(m=>m.role==="user"&&tasks.has(m.taskId));
    const noUpload=new Set();
    for(const m of stopped){const media=tx.objectStore("media"),record=await request(media.get(m.key));if(m.deleted)noUpload.add(m.id);if(record?.wav){media.put({...record,wav:undefined,processed:true,localOnly:true});noUpload.add(m.id);}}
    const uploadKey="chat-upload:"+scope,uploads=(await request(store.get(uploadKey)))?.value || [];
    store.put({id:uploadKey,value:uploads.filter(id=>!noUpload.has(id))});
    return removed.size > 0;
  });
}
export async function remove(settings, ids, clear=false) {
  const financialChanged = await transaction(["meta","messages","media","outbox"],async tx=>{
    const scope=scopeOf(settings),store=tx.objectStore("meta"),head=(await request(store.get(stateKey(scope))))?.value || {epoch:0,cursor:0};
    const all=await request(tx.objectStore("messages").index("scope").getAll(scope));
    const selected=all.filter(m=>(!m.deleted||m.expired)&&(clear||ids.includes(m.id))),tasks=new Set(selected.filter(m=>m.status!=="applied").map(m=>m.taskId));
    const pending=(await request(store.get(deleteKey(scope))))?.value || {ids:[],epoch:head.epoch};
    for(const m of selected){tx.objectStore("messages").put({...m,deleted:true,text:"",transcript:"",result:undefined,categoryStyle:undefined,localDelete:true});tx.objectStore("media").delete(m.key);}
    for(const m of all)if(!m.deleted&&!selected.some(x=>x.id===m.id)&&tasks.has(m.taskId))tx.objectStore("messages").put({...m,status:"cancelled",localSaved:false});
    const financialChanged = await cancelLocal(tx,store,scope,tasks);
    const deletedTasks=new Set(selected.map(m=>m.taskId)),results=(await request(store.get("ai-results")))?.value || [];
    store.put({id:"ai-results",value:results.filter(x=>x.scope!==scope||!deletedTasks.has(x.taskId))});
    store.put({id:deleteKey(scope),value:clear?{clear:true,clearIDs:[...(pending.clearIDs || []),crypto.randomUUID()],ids:[],epoch:pending.clear?pending.epoch:head.epoch}:{...pending,ids:[...new Set([...pending.ids,...ids])]}});
    if(clear)store.put({id:stateKey(scope),value:{epoch:head.epoch+1,cursor:0}});
    const key="ai-context:"+settings.bookId,context=(await request(store.get(key)))?.value;
    if(clear||tasks.has(context?.taskId))store.put({id:key,value:null});
    return financialChanged;
  });
  if (financialChanged) window.dispatchEvent(new Event('finance-updated'));
}
export async function pendingDeletion(settings) { return meta(deleteKey(scopeOf(settings))); }
export async function acceptDeletion(settings, deletion,serverEpoch) {
  return transaction(["meta","messages"],async tx=>{
    const store=tx.objectStore("meta"),key=deleteKey(scopeOf(settings)),current=(await request(store.get(key)))?.value;
    if(JSON.stringify(current)===JSON.stringify(deletion)){
      store.delete(key);
      if(deletion.clear&&Number.isSafeInteger(serverEpoch)){
        const scope=scopeOf(settings),head=(await request(store.get(stateKey(scope))))?.value;
        if(head&&serverEpoch>head.epoch){
          const queue=(await request(store.get("ai-queue")))?.value || [];
          for(const q of queue)if(q.scope===scope&&q.input.chatEpoch===head.epoch){q.input.chatEpoch=serverEpoch;const messages=tx.objectStore("messages"),m=await request(messages.get(messageKey(scope,q.input.id)));if(m&&!m.deleted)messages.put({...m,epoch:serverEpoch});}
          store.put({id:"ai-queue",value:queue});store.put({id:stateKey(scope),value:{...head,epoch:serverEpoch,cursor:0,initialized:false}});
        }
      }
    }
    else if(current && !current.clear)store.put({id:key,value:{...current,ids:current.ids.filter(id=>!deletion.ids.includes(id))}});
  });
}
export async function accept(settings, page, {older=false,changes=false}={}) {
  if(!Array.isArray(page.messages)||!Number.isSafeInteger(page.epoch)||!Number.isSafeInteger(page.cursor))throw Error("Неверная страница переписки");
  const result = await withQuotaRetry(()=>transaction(["meta","messages","media","outbox"],async tx=>{
    const scope=scopeOf(settings),store=tx.objectStore("meta"),head=(await request(store.get(stateKey(scope))))?.value || {epoch:0,cursor:0};
    if(page.epoch<head.epoch)return {accepted:false, financialChanged:false};
    const messages=tx.objectStore("messages"),tasks=new Set(),forgotten=new Set(),queue=(await request(store.get("ai-queue")))?.value || [];
    if(page.epoch>head.epoch){
      const all=await request(messages.index("scope").getAll(scope));
      for(const m of all)if((m.epoch || 0)<page.epoch){messages.put({...m,deleted:true,text:"",transcript:"",result:undefined,categoryStyle:undefined});tx.objectStore("media").delete(m.key);if(m.status!=="applied")tasks.add(m.taskId);forgotten.add(m.taskId);}
    }
    const previous=await Promise.all(page.messages.map(m=>request(messages.get(messageKey(scope,m.id)))));
    for(const [index,m] of page.messages.entries()){
      const key=messageKey(scope,m.id),prior=previous[index];
      if(prior?.localDelete || (prior?.seq>m.seq && page.epoch===head.epoch))continue;
      if(m.expired&&prior&&queue.some(q=>q.scope===scope&&q.input.id===m.id))continue;
      const value={...m,key,scope,epoch:page.epoch,cachedAudio:!!prior?.cachedAudio,...(!m.deleted&&prior?.categoryStyle?{categoryStyle:prior.categoryStyle}:{})};
      messages.put(value);
      if(m.deleted)tx.objectStore("media").delete(key);
      else if(m.media?.available===false){const record=await request(tx.objectStore("media").get(key));if(record?.processed&&!record.wav){tx.objectStore("media").delete(key);messages.put({...value,cachedAudio:false});}}
      if(m.status==="cancelled")tasks.add(m.taskId);
      if(m.deleted)forgotten.add(m.taskId);
    }
    const financialChanged = await cancelLocal(tx,store,scope,tasks);
    if(forgotten.size){const results=(await request(store.get("ai-results")))?.value || [];store.put({id:"ai-results",value:results.filter(x=>x.scope!==scope||!forgotten.has(x.taskId))});}
    const next={...head,epoch:page.epoch,initialized:true,cursor:older?head.cursor:Math.max(head.cursor,page.cursor)};
    if(!changes){next.before=page.before;next.more=page.more;}
    store.put({id:stateKey(scope),value:next});
    return {accepted:true, financialChanged};
  }));
  if (result.financialChanged) window.dispatchEvent(new Event('finance-updated'));
  return result.accepted;
}
export async function detach(settings) {
  return transaction(["meta"],tx=>{const s=tx.objectStore("meta");s.put({id:"ai-context:"+settings.bookId,value:null});s.put({id:"ai-active:"+scopeOf(settings),value:null});});
}
export async function cancelTask(settings,taskId) {
  const financialChanged = await transaction(["meta","messages","outbox","media"],async tx=>{
    const scope=scopeOf(settings),store=tx.objectStore("meta");
    const financialChanged = await cancelLocal(tx,store,scope,new Set([taskId]));
    for(const m of await request(tx.objectStore("messages").index("scope").getAll(scope)))if(m.taskId===taskId&&!m.deleted)tx.objectStore("messages").put({...m,status:"cancelled"});
    const key="ai-context:"+settings.bookId;if((await request(store.get(key)))?.value?.taskId===taskId)store.put({id:key,value:null});
    return financialChanged;
  });
  if (financialChanged) window.dispatchEvent(new Event('finance-updated'));
}
export async function pendingMedia(settings) {
  const db=await openDB(),scope=scopeOf(settings),ids=await meta("chat-upload:"+scope) || [],store=db.transaction("media").objectStore("media");
  const rows=(await Promise.all(ids.map(id=>request(store.get(messageKey(scope,id)))))).filter(Boolean);
  return rows.filter(m=>m.processed&&!m.uploaded&&m.blob&&Date.now()-Date.parse(m.createdAt)<30*day).map(m=>({...m,blob:audioBlob(m.blob)}));
}
export async function cacheMedia(settings,id,blob,uploaded=true) {
  if(blob.size>4*1024*1024 || !/^audio\/(webm|mp4|ogg|wav)(;|$)/i.test(blob.type))throw Error("Неверная аудиозапись");
  const packed=await packedAudio(blob);
  return withQuotaRetry(()=>transaction(["media","messages"],async tx=>{
    const scope=scopeOf(settings),key=messageKey(scope,id),m=await request(tx.objectStore("messages").get(key));
    if(!m || m.deleted)return;
    const prior=await request(tx.objectStore("media").get(key));
    tx.objectStore("media").put({...prior,key,id,scope,ownerId:settings.userId,bookId:settings.bookId,blob:packed,createdAt:m.createdAt,uploaded,processed:true});
    tx.objectStore("messages").put({...m,cachedAudio:true});
  }));
}
export async function uploaded(settings,id) {
  return transaction(["media","meta"],async tx=>{
    const scope=scopeOf(settings),s=tx.objectStore("media"),key=messageKey(scope,id),m=await request(s.get(key));if(m)s.put({...m,uploaded:true});
    const meta=tx.objectStore("meta"),uploadKey="chat-upload:"+scope,ids=(await request(meta.get(uploadKey)))?.value || [];meta.put({id:uploadKey,value:ids.filter(x=>x!==id)});
  });
}
export async function prune() {
  return transaction(["messages","media","meta"],async tx=>{
    const meta=tx.objectStore("meta"),queue=(await request(meta.get("ai-queue")))?.value || [],pending=new Set(queue.map(q=>q.scope+":"+q.input.id));
    const media=tx.objectStore("media"),rows=await request(media.getAll()),used=new Map();
    rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.key.localeCompare(a.key));
    for(const m of rows){
      if(m.legacy||!m.processed||m.wav)continue;
      const size=m.blob?.size || 0,bytes=(used.get(m.ownerId)||0)+size;used.set(m.ownerId,bytes);
      if(Date.now()-Date.parse(m.createdAt)>30*day||bytes>audioLimit){
        media.delete(m.key);
        const store=tx.objectStore("messages"),message=await request(store.get(m.key));
        if(message&&!message.deleted)store.put({...message,media:{available:false},audio:true,cachedAudio:false});
      }
    }
    const store=tx.objectStore("messages"),messages=await request(store.getAll());
    for(const m of messages)if(!m.deleted&&m.seq>0&&!pending.has(m.key)&&Date.now()-Date.parse(m.createdAt)>90*day){store.put({...m,deleted:true,expired:true,text:"",transcript:"",result:undefined,categoryStyle:undefined});media.delete(m.key);}
    const results=(await request(meta.get("ai-results")))?.value || [];
    meta.put({id:"ai-results",value:results.filter(x=>x.contextMode!=="explicit"||!x.createdAt||Date.now()-x.createdAt<=90*day)});
  },"relaxed");
}
