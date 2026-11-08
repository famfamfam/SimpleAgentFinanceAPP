import * as db from "/db.js";
import * as chat from "/chat-db.js";

const writes = new Map();
export function waitForDraft(settings) {
  return writes.get(chat.scopeOf(settings)) || Promise.resolve();
}
export async function readDraft(settings, kind = "ai") {
  settings = { ...settings };
  await waitForDraft(settings);
  return chat.readDraft(settings, kind);
}
export async function readDrafts(settings) {
  settings = { ...settings };
  await waitForDraft(settings);
  return db.transaction(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    return {
      text: await chat.draftValue(store, settings),
      entryReturn: await chat.draftValue(store, settings, "entry"),
    };
  });
}
export function writeDraft(settings, value, kind = "ai") {
  settings = { ...settings };
  const scope = chat.scopeOf(settings);
  const write = waitForDraft(settings)
    .catch(() => {})
    .then(() => chat.writeDraft(settings, value, kind));
  writes.set(scope, write);
  write.then(
    () => {
      if (writes.get(scope) === write) writes.delete(scope);
    },
    () => {
      if (writes.get(scope) === write) writes.delete(scope);
    },
  );
  return write;
}
