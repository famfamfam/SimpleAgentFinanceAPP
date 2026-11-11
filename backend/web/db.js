import { initialState, cents, currencyCode, summarizeByCurrency, validateEntry, assistantContext, bufferBase64, base64Buffer } from "./model.js";
import { draftValue, putDraft, preserveDrafts } from "./chat-db.js";
import { getLanguage, t } from "./i18n.js";
const name =
  location.pathname === "/benchmark.html"
    ? "finance-benchmark-v1"
    : "finance-v1";
let connection;
export function openDB() {
  if (connection) return connection;
  connection = (async () => {
    let databases;
    try { databases = await indexedDB.databases?.(); } catch {}
    let current = Array.isArray(databases)
      ? databases.find(db => db.name === name)?.version || 0
      : await new Promise(resolve => {
          const probe = indexedDB.open(name); // без версии: не апгрейдит и не блокируется
          let created = false;
          probe.onupgradeneeded = () => { created = true; }; // срабатывает только при создании базы
          probe.onsuccess = () => { resolve(created ? 0 : probe.result.version); probe.result.close(); };
          probe.onerror = () => resolve(0);
        });
    if (current > 0 && current < 4 &&
        !window.confirm(t("Перед обновлением данных сохраните формы и закройте старые окна приложения. Продолжить?")))
      throw Error("Обновление данных отменено");
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 4);
      r.onupgradeneeded = (event) => {
        for (const store of ["meta", "base", "outbox"])
          if (!r.result.objectStoreNames.contains(store))
            r.result.createObjectStore(store, { keyPath: "id" });
        for (const name of ["messages", "media"]) if (!r.result.objectStoreNames.contains(name)) {
          const store = r.result.createObjectStore(name, { keyPath:"key" });
          store.createIndex("scope", "scope");
          if (name === "messages") store.createIndex("scope-created", ["scope","createdAt","id"]);
        }
        if (event.oldVersion === 1) {
          const store = r.transaction.objectStore("base"),
            rows = store.getAll();
          rows.onsuccess = () => {
            store.clear();
            store.put({ id: "snapshot", data: stateFromRows(rows.result) });
          };
        }
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () =>
        reject(Error("Закройте другие вкладки приложения и повторите"));
    });
  })().catch(error => { connection = undefined; throw error; });
  return connection;
}
export const request = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
export async function transaction(stores, fn, durability = "strict") {
  const db = await openDB();
  const tx = db.transaction(stores, "readwrite", { durability });
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || Error("Не удалось сохранить данные"));
    tx.onerror = () => {};
  });
  try {
    const out = await fn(tx);
    await done;
    return out;
  } catch (e) {
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw e;
  }
}
export async function meta(id) {
  const draft = /^(ai|entry)-draft:(.+)$/.exec(id);
  if (draft) return transaction(["meta"], async tx => {
    const store = tx.objectStore("meta"), settings = (await request(store.get("settings")))?.value;
    if (settings?.bookId !== draft[2]) throw Error("Книга или пользователь изменились. Обновите экран");
    return draftValue(store, settings, draft[1]);
  });
  const db = await openDB();
  return (await request(db.transaction("meta").objectStore("meta").get(id)))
    ?.value;
}
export async function setMeta(id, value) {
  return transaction(["meta"], async tx => {
    const store = tx.objectStore("meta"), draft = /^(ai|entry)-draft:(.+)$/.exec(id);
    if (id === "settings" || draft) {
      const settings = (await request(store.get("settings")))?.value;
      if (draft) {
        if (settings?.bookId !== draft[2]) throw Error("Книга или пользователь изменились. Обновите экран");
        return putDraft(store, settings, draft[1], value);
      }
      if (settings?.bookId !== value.bookId || settings?.userId !== value.userId) await preserveDrafts(store, settings);
    }
    store.put({ id, value });
  });
}
export async function connectionError(bookId, userId, status) {
  return transaction(["meta"], async tx => {
    const store = tx.objectStore("meta"), settings = (await request(store.get("settings"))).value;
    if (settings.bookId !== bookId || settings.userId !== userId) return false;
    const flag = status === 403 ? "revoked" : "authRequired";
    const changed = !settings[flag];
    store.put({ id: "settings", value: { ...settings, [flag]: true } });
    return changed;
  });
}
export async function reconnect(bookId, userId, nickname) {
  return transaction(["meta"], async tx => {
    const store = tx.objectStore("meta"), settings = (await request(store.get("settings"))).value;
    if (settings.bookId !== bookId || settings.userId !== userId)
      throw Error("Книга или пользователь изменились. Повторите вход");
    store.put({ id: "settings", value: { ...settings, connected: true, revoked: false, authRequired: false, nickname } });
  });
}
export async function enqueueAI(item) {
  return transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    const settings = (await request(store.get("settings"))).value;
    if (settings.bookId !== item.bookId) throw Error("Книга изменилась. Отправьте запрос заново");
    const queue = (await request(store.get("ai-queue")))?.value || [];
    if (queue.filter(x => x.bookId === item.bookId).length >= 5)
      throw Error("В очереди уже пять запросов. Дождитесь ответа или уберите лишние");
    queue.push(item);
    store.put({ id: "ai-queue", value: queue });
    await putDraft(store, settings, "ai", "");
    if (item.input.mode === "auto") store.put({ id: "ai-context:" + item.bookId, value: {
      taskId: item.input.taskId, date: item.input.date, time: item.input.time, accountId: item.input.accountId,
      previous: item.input.previous || [], updatedAt: Date.now(), receipt: !!item.input.image,
    } });
  });
}
export async function editAI(id, bookId, patch) {
  return transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    const queue = (await request(store.get("ai-queue")))?.value || [];
    const next = queue.flatMap(item =>
      item.input.id === id && item.bookId === bookId
        ? patch ? [{ ...item, ...patch }] : []
        : [item]);
    store.put({ id: "ai-queue", value: next });
  });
}
export async function completeAI(item, response) {
  return transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    const queue = (await request(store.get("ai-queue")))?.value || [];
    const results = (await request(store.get("ai-results")))?.value || [];
    if (!queue.some(x => x.input.id === item.input.id && x.bookId === item.bookId)) return results;
    if (!results.some(x => x.id === item.input.id && x.bookId === item.bookId))
      results.push({ id: item.input.id, taskId: item.input.taskId || item.input.id, bookId: item.bookId, result: response,
        prompt: item.input.text, audio: item.input.audio, createdAt: item.createdAt || Date.now(), saved: false, entryDraftId: item.entryDraftId });
    const tasks = [...new Set(results.map(x => x.taskId || x.id).reverse())].slice(0,20);
    const turns = new Map();
    const kept = results.slice().reverse().filter(x => {
      const id = x.taskId || x.id, count = (turns.get(id) || 0) + 1; turns.set(id,count);
      return (tasks.includes(id) && count <= 20) || (!x.saved && x.result.entries?.length && count === 1);
    }).reverse();
    let voices = 0;
    for (let i=kept.length-1;i>=0;i--) if (kept[i].audio && ++voices > 20) kept[i] = { ...kept[i], audio:undefined };
    store.put({ id: "ai-results", value: kept });
    store.put({ id: "ai-queue", value: queue.filter(x => x.input.id !== item.input.id || x.bookId !== item.bookId) });
    const key = "ai-context:" + item.bookId, context = (await request(store.get(key)))?.value;
    if (context?.taskId === item.input.taskId) {
      const text = JSON.stringify({ text: response.text, entries: response.entries, question: response.question });
      store.put({ id:key, value: { ...context, time: ["clarify","review"].includes(response.action) ? context.time : undefined, updatedAt: Date.now(), previous: assistantContext([
        ...(item.input.previous || []), { role:"user", content:(item.input.audio ? response.transcript : item.input.text) || item.input.text || "Голосовой запрос" },
        { role:"assistant", content:text },
      ]) } });
    }
    return kept;
  });
}
export async function markAISaved(id, bookId) {
  return transaction(["meta"], async tx => {
    const store = tx.objectStore("meta");
    const results = (await request(store.get("ai-results")))?.value || [];
    store.put({ id: "ai-results", value: results.map(item =>
      item.id === id && item.bookId === bookId ? { ...item, saved: true } : item) });
  });
}
export async function reviewAssistant(id, bookId, message) {
  return transaction(["meta","messages"], async tx => {
    const store = tx.objectStore("meta"), results = (await request(store.get("ai-results")))?.value || [];
    store.put({ id:"ai-results", value:results.map(x => x.id === id && x.bookId === bookId && !x.saved
      ? { ...x, result:{ ...x.result, action:"review", text:message } } : x) });
    const result=results.find(x=>x.id===id&&x.bookId===bookId);
    if(result?.scope)for(const m of await request(tx.objectStore("messages").index("scope").getAll(result.scope)))if(m.replyTo===id&&!m.deleted)tx.objectStore("messages").put({...m,text:message,result:{...m.result,action:"review",text:message}});
  });
}
const recordId = (entity, id) => `${entity}:${id}`;
const keyFor = (entity) =>
  ({ entry: "entries", account: "accounts", category: "categories" })[entity];
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function stateFromRows(rows) {
  const snapshot = rows.find((x) => x.id === "snapshot");
  if (snapshot) return snapshot.data;
  const state = { accounts: [], categories: [], entries: [] };
  for (const row of rows) state[keyFor(row.entity)].push(row.data);
  return state;
}
function expandBase(rows) {
  const snapshot = rows.find((x) => x.id === "snapshot");
  if (!snapshot) return rows;
  const out = [];
  for (const entity of ["account", "category", "entry"])
    for (const data of snapshot.data[keyFor(entity)])
      out.push({ id: recordId(entity, data.id), entity, data });
  return out;
}
export async function initialize() {
  await openDB();
  if (await meta("settings")) return;
  const settings = {
    bookId: crypto.randomUUID(),
    bookName: t("Личный учет"),
    initialLanguage: getLanguage(),
    connected: false,
    nickname: t("Я"),
    revision: 0,
  };
  await transaction(["meta", "base"], (tx) => {
    tx.objectStore("meta").put({ id: "settings", value: settings });
    tx.objectStore("base").put({ id: "snapshot", data: initialState() });
  });
}
export async function load() {
  const db = await openDB();
  const tx = db.transaction(["base", "outbox", "meta"]);
  const [base, pending, settings] = await Promise.all([
    request(tx.objectStore("base").getAll()),
    request(tx.objectStore("outbox").getAll()),
    request(tx.objectStore("meta").get("settings")),
  ]);
  pending.sort((a, b) => a.order - b.order);
  return { state: viewState(base, pending), pending, settings: settings.value };
}
function viewState(base, pending) {
  const map = new Map(expandBase(base).map((x) => [x.id, x]));
  for (const c of pending)
    map.set(recordId(c.entity, c.data.id), {
      id: recordId(c.entity, c.data.id),
      entity: c.entity,
      data: {
        ...c.data,
        _pending: true,
        _issue: c.status === "pending" ? "" : c.error || "Конфликт версий",
      },
    });
  const state = { accounts: [], categories: [], entries: [] };
  for (const v of map.values()) state[keyFor(v.entity)].push(v.data);
  return state;
}

function commandCurrencies(entity, data) {
  if (entity === "account" || entity === "entry") data.currency = currencyCode(data.currency);
  if (entity === "entry" && data.kind === "transfer") {
    data.toCurrency = currencyCode(data.toCurrency || data.currency);
    if (!data.toAmount && data.toCurrency === data.currency) data.toAmount = data.amount;
  }
  return data;
}
export async function save(entity, data, expectedBook) {
  return saveMany([{ entity, data }], expectedBook);
}
export async function saveAssistant(id, bookId, entries, categories = []) {
  return saveMany([...categories.map(data => ({entity:"category",data})),...entries.map(data => ({ entity:"entry", data }))], bookId, undefined, id);
}
function assertScope(settings, expected) {
  if (!expected) return;
  const bookId = typeof expected === "string" ? expected : expected.bookId;
  if (settings?.bookId !== bookId || (typeof expected === "object" && settings?.userId !== expected.userId))
    throw Error("Книга или пользователь изменились. Откройте окно заново");
}
export async function saveMany(items, expectedBook, imported, assistantID) {
  const expected = expectedBook;
  if (typeof expectedBook === "object") expectedBook = expectedBook?.bookId;
  return transaction(["meta", "base", "outbox", "messages"], async (tx) => {
    const settings = await request(tx.objectStore("meta").get("settings"));
    assertScope(settings.value, expected);
    const outbox = tx.objectStore("outbox"),
      all = (await request(outbox.getAll())).sort((a, b) => a.order - b.order),
      snapshot = await request(tx.objectStore("base").get("snapshot"));
    const metaStore = tx.objectStore("meta");
    let result, results, marker;
    if (assistantID) {
      results = (await request(metaStore.get("ai-results")))?.value || [];
      result = results.find(x => x.id === assistantID && x.bookId === expectedBook);
      if (!result || result.cancelled || (result.ownerId && result.ownerId!==settings.value.userId)) throw Error("Задача больше не доступна. Начните новую");
      marker = `ai-saved:${expectedBook}:${result.taskId || result.id}`;
      const saved = (await request(metaStore.get(marker)))?.value;
      if (result.saved || saved) return saved || { ids: result.result.entries.map(e => e.id), alreadyApplied:true };
      if ((!items.length && (!result.result.category || result.result.entries.length)) || items.length > 51) throw Error("Нет записей для сохранения");
      const state = viewState(snapshot ? [snapshot] : [], all);
      for (const { entity, data } of items) {
        if (!uuid(data.id)) throw Error("Неверный ID записи");
        if (entity === "category") {
          if (data.id!==result.result.category?.id || data.deleted || !data.name?.trim() || [...data.name.trim()].length>80 || !["expense","income"].includes(data.kind) || !/^#[0-9a-f]{6}$/i.test(data.color))throw Error("Проверьте категорию");
          if(state.categories.some(c=>!c.deleted && c.id!==data.id && c.kind===data.kind && c.name.trim().toLocaleLowerCase()===data.name.trim().toLocaleLowerCase()))throw Error("Категория с таким названием уже существует");
          state.categories.push(data);
        } else {
          if(entity!=="entry" || !result.result.entries.some(e=>e.id===data.id))throw Error("Операция не относится к задаче");
          validateEntry(data,state);
        }
      }
    }
    if (imported) {
      if (Object.hasOwn(imported, "expectedUser") && (settings.value.userId ?? null) !== imported.expectedUser)
        throw Error("Книга или пользователь изменились. Откройте файл заново.");
      const previous = await request(
        tx
          .objectStore("meta")
          .get(`local-import:${expectedBook}:${imported.hash}`),
      );
      if (previous) return { alreadyApplied: true, imported: 0 };
      all.sort((a, b) => a.order - b.order);
      if (
        JSON.stringify(viewState(snapshot ? [snapshot] : [], all)) !==
        imported.expectedState
      )
        throw Error(
          "Учет изменился после предпросмотра. Откройте файл заново.",
        );
    }
    let order = Math.max(Date.now(), ...all.map((x) => x.order + 1));
    const commandIDs=[], currentState = viewState(snapshot ? [snapshot] : [], all);
    for (const { entity, data } of items) {
      if (!keyFor(entity) || typeof data?.id !== "string")
        throw Error("Неверная локальная запись");
      const clean = JSON.parse(JSON.stringify(data));
      delete clean._pending;
      delete clean._issue;
      if (entity === "entry") {
        // Freeze referenced catalogs so a later offline archive follows this entry.
        const refs = {
          account: [clean.accountId, clean.toAccountId],
          category: [clean.categoryId],
        };
        for (const parent of all)
          if (!parent.sent && refs[parent.entity]?.includes(parent.data.id)) {
            parent.sent = true;
            outbox.put(parent);
          }
      }
      const relevant = all
          .filter((x) => x.entity === entity && x.data.id === clean.id)
          .sort((a, b) => a.order - b.order),
        last = relevant.at(-1);
      if (last?.status !== "pending" && last)
        throw Error("Сначала разрешите конфликт этой записи");
      if (last && !last.sent && entity !== "category" && !last.data.currency) {
        last.sent = true;
        outbox.put(last);
      }
      commandCurrencies(entity, clean);
      const state = currentState;
      if (entity === "account") {
        const previous = state.accounts.find(a => a.id === clean.id);
        if (previous && currencyCode(previous.currency) !== clean.currency)
          throw Error("Нельзя изменить валюту счёта");
      } else if (entity === "entry") {
        const previous = state.entries.find(e => e.id === clean.id);
        if (previous && currencyCode(previous.currency) !== clean.currency)
          throw Error("Нельзя изменить валюту существующей операции");
        if (!clean.deleted) {
          const source = state.accounts.find(a => a.id === clean.accountId);
          if (!source || currencyCode(source.currency) !== clean.currency)
            throw Error("Валюта операции не совпадает с валютой счёта");
          if (clean.kind === "transfer") {
            const target = state.accounts.find(a => a.id === clean.toAccountId);
            if (!target || currencyCode(target.currency) !== clean.toCurrency ||
                !clean.toAmount || cents(clean.toAmount) <= 0 ||
                (clean.currency === clean.toCurrency && cents(clean.toAmount) !== cents(clean.amount)))
              throw Error("Проверьте сумму и валюту зачисления");
          } else if (clean.toCurrency || clean.toAmount || clean.toAccountId) {
            throw Error("Второй счёт и сумма допустимы только у перевода");
          }
        }
      }
      const records = state[keyFor(entity)], index = records.findIndex(row => row.id === clean.id);
      if (index < 0) records.push(clean); else records[index] = clean;
      if (last && !last.sent) {
        last.data = clean;
        outbox.put(last);
        continue;
      }
      const base = snapshot?.data[keyFor(entity)].find(
          (x) => x.id === clean.id,
        ),
        command = {
          id: crypto.randomUUID(),
          entity,
          data: clean,
          base: last ? null : base?.version || 0,
          depends: last?.id || "",
          order: order++,
          status: "pending",
          sent: false,
          ...(result?.contextMode==="explicit"?{taskId:result.taskId,requestId:result.id,scope:result.scope,ownerId:result.ownerId}:{}),
        };
      outbox.put(command);
      all.push(command);
      commandIDs.push(command.id);
    }
    if (assistantID) {
      const ids = items.map(x => x.data.id), taskId = result.taskId || result.id;
      metaStore.put({ id:marker, value:{ ids, alreadyApplied:true } });
      metaStore.put({ id:"ai-results", value:results.map(x => x.bookId === expectedBook && (x.taskId || x.id) === taskId ? { ...x, saved:true, savedIDs:ids } : x) });
      if(result.contextMode==="explicit") {
        const groups=(await request(metaStore.get("ai-groups")))?.value || [];
        groups.push({taskId,requestId:result.id,scope:result.scope,ownerId:result.ownerId,bookId:expectedBook,commandIDs});
        metaStore.put({id:"ai-groups",value:groups});
        const messages=tx.objectStore("messages");
        for(const m of await request(messages.index("scope").getAll(result.scope)))if(m.taskId===taskId&&!m.deleted)messages.put({...m,localSaved:true,appliedIDs:ids});
      }
      const key = "ai-context:" + expectedBook, context = (await request(metaStore.get(key)))?.value;
      if (context?.taskId === taskId) metaStore.put({ id:key, value:null });
      return { ids, alreadyApplied:false };
    }
    if (imported) {
      tx.objectStore("meta").put({
        id: `local-import:${expectedBook}:${imported.hash}`,
        value: { at: new Date().toISOString(), entries: imported.count },
      });
      return { imported: imported.count };
    }
  });
}
export async function prepareBatch(expectedBook) {
  return transaction(["meta", "outbox"], async (tx) => {
    const settings = await request(tx.objectStore("meta").get("settings"));
    if (expectedBook && settings.value.bookId !== expectedBook) return [];
    const store = tx.objectStore("outbox");
    const all = (await request(store.getAll())).sort(
      (a, b) => a.order - b.order,
    );
    const selected = [],
      entities = new Set();
    const groups=(await request(tx.objectStore("meta").get("ai-groups")))?.value || [];
    const readyGroup=group=>group.bookId===settings.value.bookId && group.ownerId===settings.value.userId;
    const selectGroup=group=>{
      const commands=group.commandIDs.map(id=>all.find(c=>c.id===id));
      if(commands.some(c=>!c || c.status!=="pending" || c.depends))return null;
      for(const c of commands)store.put({...c,sent:true});
      return {...group,commands:commands.map(c=>({id:c.id,entity:c.entity,base:c.base,data:c.data}))};
    };
    for (const c of all) {
      const key = recordId(c.entity, c.data.id);
      if (c.status !== "pending" || c.depends || entities.has(key)) continue;
      if(c.taskId){if(selected.length)break;const group=groups.find(g=>readyGroup(g)&&g.taskId===c.taskId);if(group){const batch=selectGroup(group);if(batch)return batch;}continue;}
      entities.add(key);
      store.put({ ...c, sent: true });
      selected.push({ id: c.id, entity: c.entity, base: c.base, data: c.data });
      if (selected.length === 100) break;
    }
    if(!selected.length){const empty=groups.find(g=>readyGroup(g)&&g.commandIDs.length===0);if(empty)return selectGroup(empty);}
    return selected;
  });
}
export async function failAIGroup(group,message,stale=false) {
  return transaction(["meta","base","outbox","messages"],async tx=>{
    const meta=tx.objectStore("meta"),settings=(await request(meta.get("settings"))).value;
    if(settings.bookId!==group.bookId||settings.userId!==group.ownerId)return;
    const outbox=tx.objectStore("outbox"),commands=await request(outbox.getAll()),base=await request(tx.objectStore("base").getAll()),state=viewState(base,commands);
    const removed=new Set(group.commandIDs);let grew=true;
    while(grew){grew=false;for(const c of commands)if(removed.has(c.depends)&&!removed.has(c.id)){removed.add(c.id);grew=true;}}
    for(const id of removed)outbox.delete(id);
    const all=(await request(meta.get("ai-results")))?.value || [];
    meta.put({id:"ai-results",value:all.map(x=>{
      if(x.id!==group.requestId||x.scope!==group.scope)return x;
      const entries=x.result.entries.map(e=>state.entries.find(row=>row.id===e.id) || e),newCategory=commands.find(c=>group.commandIDs.includes(c.id)&&c.entity==="category");
      const result={...x.result,entries,action:x.result.category?"category":"review",text:message};
      return {...x,result,manual:true,cancelled:stale,saved:false,savedIDs:undefined,...(newCategory?{categoryDraft:state.categories.find(c=>c.id===newCategory.data.id)}:{})};
    })});
    const groups=(await request(meta.get("ai-groups")))?.value || [];
    meta.put({id:"ai-groups",value:groups.filter(g=>g.scope!==group.scope||g.taskId!==group.taskId)});
    meta.delete(`ai-saved:${group.bookId}:${group.taskId}`);
    const messages=tx.objectStore("messages");
    for(const m of await request(messages.index("scope").getAll(group.scope)))if(m.id===group.requestId||m.replyTo===group.requestId){
      const output=all.find(x=>x.id===group.requestId&&x.scope===group.scope)?.result;
      messages.put({...m,localSaved:false,status:stale?"cancelled":m.status,...(m.role==="assistant"&&output?{text:message,result:{...output,action:output.category?"category":"review",text:message}}:{})});
    }
  });
}
export async function accept(snapshot, expectedBook, appliedTask) {
  return transaction(
    ["meta", "base", "outbox"],
    async (tx) => {
      const store = tx.objectStore("outbox");
      const pending = await request(store.getAll());
      const settings = await request(tx.objectStore("meta").get("settings"));
      if (expectedBook && settings.value.bookId !== expectedBook) return;
      // One confirmed snapshot avoids thousands of IndexedDB writes on WebKit.
      if (snapshot.revision >= settings.value.revision)
        tx.objectStore("base").put({ id: "snapshot", data: snapshot.state });
      for (const result of snapshot.results || []) {
        const command = pending.find((x) => x.id === result.id);
        if (!command) continue;
        if (result.status === "ok") {
          store.delete(command.id);
          for (const child of pending.filter((x) => x.depends === command.id))
            store.put({ ...child, depends: "", base: result.version });
        } else {
          store.put({
            ...command,
            status: result.status,
            error:
              result.error ||
              (result.status === "conflict"
                ? "Запись изменена на другом устройстве"
                : "Изменение не принято"),
          });
        }
      }
      tx.objectStore("meta").put({
        id: "settings",
        value: {
          ...settings.value,
          revision: Math.max(snapshot.revision, settings.value.revision),
          lastSync: new Date().toISOString(),
          revoked: false,
          authRequired: false,
        },
      });
      if(appliedTask){
        const meta=tx.objectStore("meta"),groups=(await request(meta.get("ai-groups")))?.value || [];
        meta.put({id:"ai-groups",value:groups.filter(g=>g.taskId!==appliedTask || g.bookId!==expectedBook)});
      }
      // Confirmed snapshots can be downloaded again; unsent local edits keep strict durability.
    },
    "relaxed",
  );
}
export async function resolveConflict(entity, id, keepLocal, expectedBook) {
  return transaction(["meta", "base", "outbox"], async (tx) => {
    const settings = await request(tx.objectStore("meta").get("settings"));
    assertScope(settings.value, expectedBook);
    const store = tx.objectStore("outbox");
    const all = await request(store.getAll());
    const relevant = all
      .filter((c) => c.entity === entity && c.data.id === id)
      .sort((a, b) => a.order - b.order);
    for (const c of relevant) store.delete(c.id);
    if (keepLocal && relevant.length) {
      const snapshot = await request(tx.objectStore("base").get("snapshot"));
      const current = snapshot?.data[keyFor(entity)].find((x) => x.id === id);
      store.put({
        id: crypto.randomUUID(),
        entity,
        data: commandCurrencies(entity, { ...relevant.at(-1).data }),
        base: current?.version || 0,
        depends: "",
        order: Date.now(),
        sent: false,
        status: "pending",
      });
    }
  });
}
export async function switchBook(settings, snapshot, expectedBook) {
  return transaction(["meta", "base", "outbox"], async (tx) => {
    const oldBase = await request(tx.objectStore("base").getAll());
    const oldQueue = await request(tx.objectStore("outbox").getAll());
    const previous = await request(tx.objectStore("meta").get("settings"));
    assertScope(previous?.value, expectedBook);
    await preserveDrafts(tx.objectStore("meta"), previous?.value);
    tx.objectStore("meta").put({
      id: "archive:" + Date.now(),
      value: { settings: previous?.value, base: oldBase, pending: oldQueue },
    });
    tx.objectStore("outbox").clear();
    tx.objectStore("base").put({ id: "snapshot", data: snapshot.state });
    tx.objectStore("meta").put({
      id: "settings",
      value: {
        ...settings,
        revision: snapshot.revision,
        lastSync: new Date().toISOString(),
      },
    });
  });
}
export async function backup() {
  const db = await openDB();
  const tx = db.transaction(["base", "outbox", "meta", "messages", "media"]);
  const [base, outbox, meta, messages, media] = await Promise.all([
    request(tx.objectStore("base").getAll()),
    request(tx.objectStore("outbox").getAll()),
    request(tx.objectStore("meta").getAll()),
    request(tx.objectStore("messages").getAll()),request(tx.objectStore("media").getAll()),
  ]);
  const encode = async value => `data:${value.type};base64,${bufferBase64(value.data || await value.arrayBuffer())}`;
  const attachments=[];
  for(const record of media){
    const {blob,wav,...row}=record;
    if(wav)row.wavData=await encode(wav);
    if(blob&&!record.uploaded)row.blobData=await encode(blob);
    attachments.push(row);
  }
  return {
    format: "finance-backup-v4",
    origin: location.origin,
    createdAt: new Date().toISOString(),
    base,
    outbox,
    meta,
    messages,media:attachments,
  };
}

const maxBackupBytes = 128 * 1024 * 1024;
export function backupFile(backup) {
  validateBackup(backup);
  const file = new Blob([JSON.stringify(backup)], { type: "application/json" });
  if (file.size > maxBackupBytes)
    throw Error("Копия больше 128 MiB. Скачайте книги отдельно из локальных архивов");
  return file;
}
export async function readBackup(file) {
  if (file.size > maxBackupBytes) throw Error("Копия больше 128 MiB");
  return JSON.parse(await file.text());
}
function validateBackup(backup) {
  if (
    !["finance-backup-v1", "finance-backup-v2", "finance-backup-v3", "finance-backup-v4"].includes(backup?.format) ||
    !Array.isArray(backup.base) ||
    !Array.isArray(backup.outbox) ||
    !Array.isArray(backup.meta) ||
    !backup.meta.some((x) => x?.id === "settings")
  )
    throw Error("Это не резервная копия приложения");
  const objects = [backup], seen = new WeakSet();
  while (objects.length) {
    const value = objects.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if ((key === "currency" || key === "toCurrency") && child != null && child !== "") {
        const code = currencyCode(child);
        if (backup.format !== "finance-backup-v4" && code !== "RUB")
          throw Error("Старая копия содержит данные в другой валюте");
      }
      if (child && typeof child === "object") objects.push(child);
    }
  }
  const rows = expandBase(backup.base);
  if (rows.length > 51000 || backup.outbox.length > 100000)
    throw Error("Копия слишком велика");
  for (const items of [rows, backup.outbox, backup.meta])
    if (new Set(items.map(x => x?.id)).size !== items.length)
      throw Error("Повторяющиеся ключи в копии");
  const check = (item) => {
    if (
      !item ||
      !["entry", "account", "category"].includes(item.entity) ||
      !uuid(item.data?.id)
    )
      throw Error("Поврежденная запись в копии");
    const d = item.data;
    if (item.entity === "entry") {
      cents(d.amount);
      if (d.toAmount != null && d.toAmount !== "") cents(d.toAmount);
      if (
        !["expense", "income", "transfer"].includes(d.kind) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
        new Date(d.date + "T12:00:00Z").toISOString().slice(0, 10) !== d.date ||
        (d.time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(d.time)) ||
        !uuid(d.accountId) ||
        !uuid(d.kind === "transfer" ? d.toAccountId : d.categoryId) ||
        typeof d.note !== "string" ||
        typeof d.tags !== "string"
      )
        throw Error("Поврежденная операция");
    } else {
      if (typeof d.name !== "string") throw Error("Поврежденный справочник");
      if (item.entity === "account") cents(d.opening);
      if (item.entity === "category" && !["expense", "income"].includes(d.kind))
        throw Error("Поврежденная категория");
    }
  };
  rows.forEach((item) => {
    check(item);
    if (item.id !== recordId(item.entity, item.data.id))
      throw Error("Неверный ключ записи");
  });
  backup.outbox.forEach((item) => {
    check(item);
    if (
      !uuid(item.id) ||
      !Number.isFinite(item.order) ||
      !["pending", "conflict", "invalid"].includes(item.status)
    )
      throw Error("Поврежденная очередь");
  });
  const settings = backup.meta.find((x) => x.id === "settings").value;
  if (
    !settings ||
    !uuid(settings.bookId) ||
    typeof settings.bookName !== "string"
  )
    throw Error("Поврежденные настройки");
  if (settings.connected && backup.origin && backup.origin !== location.origin)
    throw Error("Эта копия подключена к другому серверу. Перенесите записи через XLSX или откройте исходный адрес");
  for (const item of backup.meta) {
    const value = item.value;
    if (typeof item.id !== "string" ||
      (item.id === "ai-queue" && (!Array.isArray(value) || value.some(x =>
        !uuid(x?.bookId) || !uuid(x.input?.id) || typeof x.input.text !== "string"))) ||
      (item.id === "ai-results" && (!Array.isArray(value) || value.some(x =>
        !uuid(x?.id) || !uuid(x.bookId) || typeof x.result?.text !== "string" ||
        !Array.isArray(x.result.entries) || x.result.entries.some(e => !uuid(e?.id))))) ||
      (item.id.startsWith("ai-draft:") && typeof value !== "string") ||
      (item.id.startsWith("entry-draft:") && value != null &&
        (!uuid(value.draft?.id) || typeof value.draft.note !== "string" || typeof value.draft.tags !== "string")))
      throw Error("Поврежденные настройки или запросы помощника");
    if (["ai-queue", "ai-results"].includes(item.id)) for (const task of value) {
      const output = task.result, input = task.input;
      const audio = task.audio || input?.audio;
      if ((task.taskId && !uuid(task.taskId)) || (input?.taskId && !uuid(input.taskId)) ||
          (audio && (typeof audio !== "string" || audio.length > 2600000 || (audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)))) ||
          (output?.action && !["add","clarify","answer","review","category"].includes(output.action)) ||
          (output?.question && (typeof output.question.text !== "string" || !Array.isArray(output.question.choices) || output.question.choices.length > 3 || output.question.choices.some(c => !uuid(c.categoryId) || typeof c.label !== "string"))))
        throw Error("Поврежденные данные задачи помощника");
    }
    if (item.id.startsWith("ai-context:") && value != null &&
        (!uuid(value.taskId) || !Number.isFinite(value.updatedAt) || !Array.isArray(value.previous) || value.previous.length > 4 || value.previous.some(t => !["user","assistant"].includes(t.role) || typeof t.content !== "string")))
      throw Error("Поврежденный контекст помощника");
  }
  if(["finance-backup-v3", "finance-backup-v4"].includes(backup.format)){
    if(!Array.isArray(backup.messages)||!Array.isArray(backup.media))throw Error("Повреждённый архив переписки");
    for(const records of [backup.messages,backup.media]){
      if(records.length>100000 || new Set(records.map(m=>m?.key)).size!==records.length)throw Error("Повреждённые ключи переписки");
      for(const m of records)if(typeof m.scope!=="string" || !uuid(m.id) || m.key!==`${m.scope}:${m.id}` || !Number.isFinite(Date.parse(m.createdAt)))throw Error("Повреждённое сообщение или аудио");
    }
    for(const m of backup.messages)if(!uuid(m.taskId) || !["user","assistant"].includes(m.role) || typeof m.text!=="string" || (m.transcript!=null&&typeof m.transcript!=="string") || !Number.isSafeInteger(m.seq)||m.seq<0 || (m.result && (typeof m.result.text!=="string" || !Array.isArray(m.result.entries))))throw Error("Повреждённое сообщение");
    for(const m of backup.media)for(const key of ["blobData","wavData"])if(m[key]!=null && (typeof m[key]!=="string" || m[key].length>5700000 || !/^data:audio\/(?:webm|mp4|ogg|wav)(?:;[^,]*)?;base64,[A-Za-z0-9+/]*={0,2}$/.test(m[key])))throw Error("Повреждённая запись голоса");
  }
  const groups=backup.meta.find(m=>m.id==="ai-groups")?.value || [];
  if(!Array.isArray(groups)||groups.some(g=>!uuid(g.taskId)||!uuid(g.requestId)||!uuid(g.bookId)||typeof g.scope!=="string"||!Array.isArray(g.commandIDs)||g.commandIDs.some(id=>!uuid(id))))throw Error("Повреждённая группа команд помощника");
  const validateBook = (base, pending) => {
    if (!Array.isArray(base) || !Array.isArray(pending)) throw Error("Повреждённый архив книги");
    const state = stateFromRows(expandBase(base));
    summarizeByCurrency(state, state.entries);
    const view = viewState(base, [...pending].sort((a, b) => a.order - b.order));
    summarizeByCurrency(view, view.entries);
  };
  validateBook(backup.base, backup.outbox);
  for (const item of backup.meta)
    if (item.id.startsWith("archive:")) validateBook(item.value?.base, item.value?.pending);
  return rows;
}
export async function restore(backup, expectedScope) {
  const rows = validateBackup(backup);
  const attachments=(backup.media || []).map(m=>{
    const {blobData,wavData,...record}=m;
    const decode=text=>{const [prefix,bytes]=text.split(","),data=base64Buffer(bytes);return {data,size:data.byteLength,type:prefix.slice(5,prefix.lastIndexOf(";base64"))};};
    if(blobData)record.blob=decode(blobData);if(wavData)record.wav=decode(wavData);return record;
  });
  await transaction(["base", "outbox", "meta", "messages", "media"], async (tx) => {
    const meta=tx.objectStore("meta");
    assertScope((await request(meta.get("settings")))?.value, expectedScope);
    const preserved=(await request(meta.getAll())).filter(m=>m.id.startsWith("chat:")||m.id.startsWith("chat-delete:")||m.id.startsWith("chat-upload:")||m.id.startsWith("ai-saved:"));
    for (const name of ["base", "outbox", "meta"]) tx.objectStore(name).clear();
    tx.objectStore("base").put({ id: "snapshot", data: stateFromRows(rows) });
    for (const [store, items] of [
      ["outbox", backup.outbox],
      ["meta", backup.meta],
    ])
      for (const item of items) tx.objectStore(store).put(item);
    await preserveDrafts(meta, backup.meta.find(item => item.id === "settings").value);
    for(const item of preserved){
      const restored=backup.meta.find(m=>m.id===item.id);
      if(item.id.startsWith("chat-upload:"))meta.put({...item,value:[...new Set([...item.value,...(restored?.value || [])])]});
      else if(!item.id.startsWith("chat:") || !restored || item.value.epoch>=restored.value.epoch)meta.put(item);
    }
    const messages=tx.objectStore("messages"),media=tx.objectStore("media");
    for(const m of backup.messages || []){
      const existing=await request(messages.get(m.key));
      if(!existing || (!existing.deleted && existing.seq<m.seq))messages.put({...m,cachedAudio:!!backup.media?.find(a=>a.key===m.key&&(a.blobData||a.wavData))});
    }
    for(const record of attachments){
      const m=await request(messages.get(record.key));if(((m&&!m.deleted)||record.legacy)&&!await request(media.get(record.key)))media.put(record);
    }
    const groups=(await request(meta.get("ai-groups")))?.value || [],rejected=[];
    for(const group of groups){const m=await request(messages.get(`${group.scope}:${group.requestId}`));if(m?.localDelete||m?.status==="cancelled"||(m?.deleted&&!m.expired))rejected.push(group);}
    if(rejected.length){
      const ids=new Set(rejected.flatMap(g=>g.commandIDs)),all=await request(tx.objectStore("outbox").getAll());
      let grew=true;while(grew){grew=false;for(const c of all)if(ids.has(c.depends)&&!ids.has(c.id)){ids.add(c.id);grew=true;}}
      for(const id of ids)tx.objectStore("outbox").delete(id);
      meta.put({id:"ai-groups",value:groups.filter(g=>!rejected.includes(g))});
    }
    for(const key of ["ai-queue","ai-results"]){
      const all=(await request(meta.get(key)))?.value || [],kept=[];
      for(const item of all){
        const id=item.input?.id || item.id;
        if(item.scope){const m=await request(messages.get(`${item.scope}:${id}`));if(m?.localDelete||m?.status==="cancelled"||(m?.deleted&&!m.expired))continue;}
        kept.push(key==="ai-results"&&item.contextMode!=="explicit"?{...item,manual:true}:item);
      }
      meta.put({id:key,value:kept});
    }
  });
}
