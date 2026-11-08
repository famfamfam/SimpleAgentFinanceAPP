import * as db from "./db.js";
import * as chat from "./chat-db.js";
let running = null;
export async function api(path, body, method, expectedUser) {
  const response = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "X-Finance-Data-Version":"4",...(body?{"Content-Type":"application/json"}:{}),...(expectedUser?{"X-Finance-User":expectedUser}:{}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(path.includes("assistant") ? 85000 : 20000),
  });
  if (!response.ok) {
    let message = "Сервер временно недоступен",code="";
    try {
      const body=await response.json();message=body.error || message;code=body.code || "";
    } catch {}
    const error = Error(message);
    error.status = response.status;
    error.code=code;
    error.retryAfter = Math.max(0, Math.min(86400, Number(response.headers.get("Retry-After")) || 0));
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}
export async function sync({ wait = false } = {}) {
  if (!navigator.onLine) return;
  if (running) {
    if (!wait) return;
    await running;
    return sync({ wait });
  }
  const task = (async () => {
  let source;
  try {
    const settings = await db.meta("settings");
    source = settings;
    if (!settings.connected || settings.revoked) return;
    const operation = async () => {
      await syncChatDeletions(settings);
      for (let batch = 0; batch < 100; batch++) {
        const latest=await db.meta("settings");
        if(latest.bookId!==settings.bookId || latest.userId!==settings.userId || !latest.connected)break;
        const prepared = await db.prepareBatch(settings.bookId), commands = Array.isArray(prepared)?prepared:prepared.commands;
        let snapshot;
        try {
          snapshot=await api(prepared.taskId?`/api/books/${settings.bookId}/assistant-tasks/${prepared.taskId}/apply`:`/api/books/${settings.bookId}/sync`,
            prepared.taskId?{requestId:prepared.requestId,commands}:commands.length?{commands}:undefined,undefined,settings.userId);
        } catch(error) {
          if(prepared.taskId && error.status===410){await chat.cancelTask(settings,prepared.taskId);window.dispatchEvent(new CustomEvent("finance-error",{detail:error}));continue;}
          if(prepared.taskId&&(error.status===400||error.code==="task_changed")){
            await db.failAIGroup(prepared,error.message,error.code==="task_changed");error.show=true;
            window.dispatchEvent(new Event("finance-updated"));window.dispatchEvent(new CustomEvent("finance-error",{detail:error}));continue;
          }
          throw error;
        }
        await db.accept(snapshot, settings.bookId,prepared.taskId);
        if (!commands.length && !prepared.taskId) break;
      }
      window.dispatchEvent(new Event("finance-updated"));
      syncChat().catch(()=>{});
    };
    if (navigator.locks)
      await navigator.locks.request(
        "finance-sync",
        wait ? {} : { ifAvailable: true },
        (lock) => (lock ? operation() : undefined),
      );
    else await operation();
  } catch (error) {
    const changed = [401, 403].includes(error.status) && source
      ? await db.connectionError(source.bookId, source.userId, error.status)
      : true;
    if (changed) window.dispatchEvent(new CustomEvent("finance-error", { detail: error }));
    throw error;
  }
  })();
  running = task;
  try { return await task; }
  finally { if (running === task) running = null; }
}

export async function syncChatDeletions(settings) {
  if((await db.meta("settings")).userId!==settings.userId)return;
  const pending=await chat.pendingDeletion(settings);
  if(!pending)return;
  let epoch;
  if(pending.clear)for(const id of pending.clearIDs || [undefined]){
    const response=await api(`/api/books/${settings.bookId}/chat/delete`,{clear:true,epoch:pending.epoch,...(id?{id}:{})},undefined,settings.userId);epoch=response.epoch;
  }
  for(let i=0;i<pending.ids.length;i+=100)await api(`/api/books/${settings.bookId}/chat/delete`,{ids:pending.ids.slice(i,i+100)},undefined,settings.userId);
  await chat.acceptDeletion(settings,pending,epoch);
}
let historyRunning=false,historyAgain=false;
export async function syncChat() {
  if(!navigator.onLine)return;
  if(historyRunning){historyAgain=true;return;}
  historyRunning=true;
  let more=false;
  try {
    const settings=await db.meta("settings");
    if(!settings.connected||!settings.userId||settings.revoked||settings.authRequired)return;
    await syncChatDeletions(settings);
    const endpoint=`/api/books/${settings.bookId}/chat`;
    let head=await chat.state(settings);
    if(!head.initialized){await chat.accept(settings,await api(endpoint,undefined,undefined,settings.userId));head=await chat.state(settings);window.dispatchEvent(new Event("finance-chat-updated"));}
    for(let i=0;i<10;i++){
      const page=await api(endpoint+"?after="+head.cursor,undefined,undefined,settings.userId);
      await chat.accept(settings,page,{changes:true});
      window.dispatchEvent(new Event("finance-chat-updated"));
      head=await chat.state(settings);
      if(!page.more)break;
      if(i===9)more=true;
    }
    // Backfill text in small pages. Opening a book never waits for the archive.
    for(let i=0;i<3&&head.more;i++){
      await chat.accept(settings,await api(endpoint+"?before="+encodeURIComponent(head.before),undefined,undefined,settings.userId),{older:true});
      window.dispatchEvent(new Event("finance-chat-updated"));
      head=await chat.state(settings);
    }
    more ||= !!head.more;
    for(const record of await chat.pendingMedia(settings)){
      if((await db.meta("settings")).userId!==settings.userId)break;
      const response=await fetch(endpoint+"/media/"+record.id,{method:"PUT",headers:{"Content-Type":record.blob.type,"X-Finance-User":settings.userId},body:record.blob,credentials:"same-origin",signal:AbortSignal.timeout(20000)});
      if(!response.ok){if(response.status===410){await chat.uploaded(settings,record.id);continue;}throw Error("Не удалось сохранить аудио на сервере");}
      await chat.uploaded(settings,record.id);
    }
    window.dispatchEvent(new Event("finance-chat-updated"));
  } finally {
    historyRunning=false;
    if(more||historyAgain){historyAgain=false;setTimeout(()=>syncChat().catch(()=>{}),250);}
  }
}
export async function loadChatAudio(settings,id) {
  const local=await chat.media(settings,id);
  if(local?.blob)return local.blob;
  if(!navigator.onLine)throw Error("Аудио ещё не скачано. Подключитесь к сети для прослушивания");
  const response=await fetch(`/api/books/${settings.bookId}/chat/media/${id}`,{headers:{"X-Finance-User":settings.userId},credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(20000)});
  if(!response.ok){let error="Не удалось загрузить запись";try{error=(await response.json()).error || error;}catch{}throw Error(error);}
  const blob=await response.blob();
  await chat.cacheMedia(settings,id,blob);
  return blob;
}
