import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await page.route("http://localhost:19876/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>test</title>" });
    if (["/db.js", "/model.js", "/chat-db.js", "/sync.js", "/icons.js"].includes(path))
      return route.fulfill({ contentType: "text/javascript", body: await readFile(`backend/web${path}`) });
    return route.fulfill({ status: 426, contentType: "application/json", body: JSON.stringify({ code: "client_update_required", error: "update required" }) });
  });
  await page.goto("http://localhost:19876/");
});

test("v3 migration warns before closing an old connection and preserves raw outbox", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const command = { id: "old-command", entity: "account", data: { id: "old-account", name: "Old" }, sent: true };
    const old = await new Promise((resolve, reject) => {
      const request = indexedDB.open("finance-v1", 3);
      request.onupgradeneeded = () => {
        for (const name of ["meta", "base", "outbox"]) request.result.createObjectStore(name, { keyPath: "id" });
        for (const name of ["messages", "media"]) request.result.createObjectStore(name, { keyPath: "key" });
        request.transaction.objectStore("outbox").put(command);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let warned = false, warnedBeforeClose = false;
    window.alert = () => { warned = true; };
    window.confirm = () => { warned = true; return true; };
    old.onversionchange = () => { warnedBeforeClose = warned; old.close(); };
    const db = await import("/db.js"), connection = await db.openDB();
    const saved = await db.request(connection.transaction("outbox").objectStore("outbox").get("old-command"));
    return { version: connection.version, warnedBeforeClose, saved };
  });
  expect(result).toEqual({ version: 4, warnedBeforeClose: true, saved: { id: "old-command", entity: "account", data: { id: "old-account", name: "Old" }, sent: true } });
});

test("v4 backups retain currencies and old formats reject non-RUB data without altering storage", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const original = await db.backup();
    const v4 = structuredClone(original);
    v4.base[0].data.accounts[0].currency = "USD";
    await db.restore(v4);
    const restored = await db.backup();
    const legacy = structuredClone(restored);
    legacy.format = "finance-backup-v3";
    let rejected = false;
    try { await db.restore(legacy); } catch { rejected = true; }
    const after = await db.backup();
    return { format: original.format, currency: restored.base[0].data.accounts[0].currency, rejected, unchanged: JSON.stringify(after.base) === JSON.stringify(restored.base) };
  });
  expect(result).toEqual({ format: "finance-backup-v4", currency: "USD", rejected: true, unchanged: true });
});

test("sync sends data version outside commands and retains queue and login on 426", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js"), { sync } = await import("/sync.js");
    await db.initialize();
    const settings = await db.meta("settings");
    await db.setMeta("settings", { ...settings, connected: true, userId: crypto.randomUUID() });
    const account = { id: "00000000-0000-4000-8000-000000000902", name: "Old", opening: "0.00" };
    await db.transaction(["outbox"], tx => tx.objectStore("outbox").put({ id: "00000000-0000-4000-8000-000000000903", entity: "account", data: account, base: 0, depends: "", order: 1, status: "pending", sent: false }));
    const before = (await db.load()).pending[0];
    let status;
    try { await sync(); } catch (error) { status = error.status; }
    const after = await db.load();
    return { status, data: after.pending[0].data, sameID: after.pending[0].id === before.id, connected: after.settings.connected, revoked: !!after.settings.revoked, authRequired: !!after.settings.authRequired };
  });
  const requests = [];
  // Header is asserted in a separate call so its fetch can be observed directly.
  await page.route("http://localhost:19876/api/version", route => { requests.push(route.request().headers()); return route.fulfill({ json: {} }); });
  await page.evaluate(async () => (await import("/sync.js")).api("/api/version"));
  expect(requests[0]["x-finance-data-version"]).toBe("4");
  expect(result).toMatchObject({ status: 426, sameID: true, connected: true, revoked: false, authRequired: false, data: { name: "Old", opening: "0.00" } });
  expect(result.data).not.toHaveProperty("currency");
});


test("editing a legacy unsent command keeps its payload and queues a new currency-aware ID", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const settings = await db.meta("settings");
    const legacy = { id: "00000000-0000-4000-8000-000000000900", entity: "account", data: { id: "00000000-0000-4000-8000-000000000901", name: "Old", opening: "0.00" }, base: 0, depends: "", order: 1, status: "pending", sent: false };
    await db.transaction(["outbox"], tx => tx.objectStore("outbox").put(legacy));
    await db.save("account", { ...legacy.data, name: "Edited", currency: "RUB" }, settings.bookId);
    const pending = (await db.load()).pending;
    const first = await db.prepareBatch(settings.bookId);
    const retry = await db.prepareBatch(settings.bookId);
    const state = (await db.backup()).base[0].data;
    await db.accept({ revision: 1, state, results: [{ id: legacy.id, status: "ok", version: 1 }] }, settings.bookId);
    const next = await db.prepareBatch(settings.bookId);
    return { first: pending[0].data, firstID: pending[0].id, second: pending[1]?.data, depends: pending[1]?.depends, retryIdentical: JSON.stringify(first) === JSON.stringify(retry), retryData: retry[0].data, nextBase: next[0]?.base, nextData: next[0]?.data };
  });
  expect(result).toEqual({ first: { id: "00000000-0000-4000-8000-000000000901", name: "Old", opening: "0.00" }, firstID: "00000000-0000-4000-8000-000000000900", second: { id: "00000000-0000-4000-8000-000000000901", name: "Edited", opening: "0.00", currency: "RUB" }, depends: "00000000-0000-4000-8000-000000000900", retryIdentical: true, retryData: { id: "00000000-0000-4000-8000-000000000901", name: "Old", opening: "0.00" }, nextBase: 1, nextData: { id: "00000000-0000-4000-8000-000000000901", name: "Edited", opening: "0.00", currency: "RUB" } });
});

test("a new non-RUB entry without its own currency is rejected instead of guessed", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const settings = await db.meta("settings");
    const id = "00000000-0000-4000-8000-000000000904";
    await db.save("account", { id, name: "USD", opening: "0.00", currency: "USD" }, settings.bookId);
    let rejected = false;
    try { await db.save("entry", { id: "00000000-0000-4000-8000-000000000905", kind: "expense", accountId: id, amount: "1.00" }, settings.bookId); } catch { rejected = true; }
    return { rejected, pending: (await db.load()).pending.length };
  });
  expect(result).toEqual({ rejected: true, pending: 1 });
});

test("same-currency USD transfers can default their matching destination metadata", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const book = (await db.meta("settings")).bookId;
    const from = "00000000-0000-4000-8000-000000000906", to = "00000000-0000-4000-8000-000000000907";
    await db.saveMany([{ entity: "account", data: { id: from, name: "from", opening: "0.00", currency: "USD" } }, { entity: "account", data: { id: to, name: "to", opening: "0.00", currency: "USD" } }], book);
    await db.save("entry", { id: "00000000-0000-4000-8000-000000000908", kind: "transfer", accountId: from, toAccountId: to, currency: "USD", amount: "1.00" }, book);
    return (await db.load()).pending.find(c => c.entity === "entry").data;
  });
  expect(result).toMatchObject({ currency: "USD", toCurrency: "USD", amount: "1.00", toAmount: "1.00" });
});

test("local batches reject account currency edits and mismatched or incomplete transfers atomically", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const local = await db.load(), book = local.settings.bookId;
    const usd = { id: "00000000-0000-4000-8000-000000000911", name: "USD", opening: "0.00", currency: "USD" };
    const entry = { id: "00000000-0000-4000-8000-000000000912", kind: "transfer", accountId: local.state.accounts[0].id, toAccountId: usd.id, amount: "10.00", currency: "RUB", toCurrency: "USD", toAmount: "1.00" };
    await db.saveMany([{ entity: "account", data: usd }, { entity: "entry", data: entry }], book);
    let rejected = 0;
    for (const [entity, data] of [["account", { ...usd, currency: "EUR" }], ["entry", { ...entry, currency: "USD" }], ["entry", { ...entry, toCurrency: "EUR" }], ["entry", { ...entry, toAmount: "" }]]) {
      try { await db.save(entity, data, book); } catch { rejected++; }
    }
    const after = await db.load();
    return { rejected, pending: after.pending.length, currency: after.state.accounts.find(a => a.id === usd.id).currency, amount: after.state.entries[0].toAmount };
  });
  expect(result).toEqual({ rejected: 4, pending: 2, currency: "USD", amount: "1.00" });
});

test("historical currencies cannot be changed but archived accounts and entry deletions remain usable", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const local = await db.load(), book = local.settings.bookId;
    const usd = { id: "00000000-0000-4000-8000-000000000913", name: "USD", opening: "0.00", currency: "USD" };
    const entry = { id: "00000000-0000-4000-8000-000000000914", kind: "expense", accountId: local.state.accounts[0].id, amount: "10.00", currency: "RUB" };
    await db.saveMany([{ entity: "account", data: usd }, { entity: "entry", data: entry }], book);
    let rejected = false;
    try { await db.save("entry", { ...entry, accountId: usd.id, currency: "USD" }, book); } catch { rejected = true; }
    await db.save("account", { ...local.state.accounts[0], deleted: true }, book);
    await db.save("entry", { ...entry, deleted: true }, book);
    const after = await db.load();
    return { rejected, accountArchived: after.state.accounts.find(a => a.id === entry.accountId).deleted, entryDeleted: after.state.entries[0].deleted };
  });
  expect(result).toEqual({ rejected: true, accountArchived: true, entryDeleted: true });
});

test("keeping a legacy conflict creates a new RUB-aware command", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const book = (await db.meta("settings")).bookId;
    const command = { id: "00000000-0000-4000-8000-000000000909", entity: "account", data: { id: "00000000-0000-4000-8000-000000000910", name: "Old", opening: "0.00" }, base: 0, depends: "", order: 1, status: "conflict", sent: true };
    await db.transaction(["outbox"], tx => tx.objectStore("outbox").put(command));
    await db.resolveConflict("account", command.data.id, true, book);
    const pending = (await db.load()).pending;
    return { count: pending.length, newID: pending[0].id !== command.id, currency: pending[0].data.currency };
  });
  expect(result).toEqual({ count: 1, newID: true, currency: "RUB" });
});

test("cancelling v3 upgrade leaves the old connection and queue untouched", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const old = await new Promise((resolve, reject) => {
      const request = indexedDB.open("finance-v1", 3);
      request.onupgradeneeded = () => request.result.createObjectStore("outbox", { keyPath: "id" }).put({ id: "keep", data: { amount: "1.00" } });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let changed = false;
    old.onversionchange = () => { changed = true; };
    window.confirm = () => false;
    let cancelled = false;
    const db = await import("/db.js");
    try { await db.openDB(); } catch { cancelled = true; }
    const saved = await db.request(old.transaction("outbox").objectStore("outbox").get("keep"));
    old.close();
    return { changed, cancelled, saved };
  });
  expect(result).toEqual({ changed: false, cancelled: true, saved: { id: "keep", data: { amount: "1.00" } } });
});

test("without databases() an up-to-date database never asks for upgrade consent", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("finance-v1", 4);
      request.onupgradeneeded = () => {
        for (const store of ["meta", "base", "outbox"]) request.result.createObjectStore(store, { keyPath: "id" });
        for (const store of ["messages", "media"]) {
          const created = request.result.createObjectStore(store, { keyPath: "key" });
          created.createIndex("scope", "scope");
        }
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    let confirmed = 0;
    window.confirm = () => { confirmed++; return true; };
    Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
    const db = await import("/db.js");
    const connection = await db.openDB();
    const version = connection.version;
    connection.close();
    return { confirmed, version };
  });
  expect(result).toEqual({ confirmed: 0, version: 4 });
});

test("restore and archive export reject currency mismatches and unequal same-currency transfers atomically", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const original = await db.backup();
    const make = mismatch => {
      const copy = structuredClone(original), state = copy.base[0].data, from = state.accounts[0];
      const to = { ...from, id: "00000000-0000-4000-8000-000000000991", name: "Second" };
      state.accounts.push(to);
      state.entries.push({ id: "00000000-0000-4000-8000-000000000992", kind: "transfer", accountId: from.id, toAccountId: to.id, currency: mismatch ? "USD" : "RUB", toCurrency: "RUB", amount: "10.00", toAmount: "1.00", date: "2026-01-01", time: "", note: "", tags: "" });
      return copy;
    };
    let rejected = 0;
    for (const mismatch of [true, false]) for (const queued of [false, true]) {
      const copy = make(mismatch);
      if (queued) copy.outbox.push({ id: "00000000-0000-4000-8000-000000000995", entity: "entry", data: copy.base[0].data.entries.pop(), base: 0, depends: "", order: 1, status: "pending", sent: true });
      try { await db.restore(copy); } catch { rejected++; }
      try { db.backupFile(copy); } catch { rejected++; }
      const nested = structuredClone(original);
      nested.meta.push({ id: "archive:1", value: { base: copy.base, pending: copy.outbox } });
      try { await db.restore(nested); } catch { rejected++; }
    }
    const after = await db.backup();
    delete original.createdAt; delete after.createdAt;
    return { rejected, unchanged: JSON.stringify(after) === JSON.stringify(original) };
  });
  expect(result).toEqual({ rejected: 12, unchanged: true });
});

test("legacy RUB queues and archived account history remain restorable without rewriting commands", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const copy = await db.backup(), state = copy.base[0].data, account = state.accounts[0];
    copy.format = "finance-backup-v3";
    account.deleted = true;
    const entry = { id: "00000000-0000-4000-8000-000000000993", kind: "expense", accountId: account.id, categoryId: state.categories[0].id, amount: "10.00", date: "2026-01-01", time: "", note: "", tags: "" };
    state.entries.push(entry);
    const command = { id: "00000000-0000-4000-8000-000000000994", entity: "entry", data: { ...entry, amount: "12.00" }, base: 1, depends: "", order: 1, status: "pending", sent: true };
    copy.outbox.push(command);
    copy.meta.push({ id: "archive:1", value: { base: structuredClone(copy.base), pending: structuredClone(copy.outbox) } });
    await db.restore(copy);
    const after = await db.backup();
    return { amount: (await db.load()).state.entries[0].amount, outbox: after.outbox, archive: after.meta.find(m => m.id === "archive:1").value.pending };
  });
  const expected = { id: "00000000-0000-4000-8000-000000000994", entity: "entry", data: { id: "00000000-0000-4000-8000-000000000993", kind: "expense", accountId: "00000000-0000-4000-8000-000000000001", categoryId: "00000000-0000-4000-8000-000000000002", amount: "12.00", date: "2026-01-01", time: "", note: "", tags: "" }, base: 1, depends: "", order: 1, status: "pending", sent: true };
  expect(result).toEqual({ amount: "12.00", outbox: [expected], archive: [expected] });
});

test("legacy RUB restores but foreign archived data and invalid v4 data are rejected atomically", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.initialize();
    const original = await db.backup();
    const legacy = structuredClone(original);
    legacy.format = "finance-backup-v3";
    await db.restore(legacy);
    const invalidArchive = structuredClone(legacy);
    invalidArchive.meta.push({ id: "archive:1", value: { base: [{ data: { accounts: [{ currency: "EUR" }] } }] } });
    const invalidCurrency = structuredClone(original);
    invalidCurrency.base[0].data.accounts[0].currency = "XYZ";
    const invalidAudio = structuredClone(original);
    invalidAudio.media = [{ key: "invalid" }];
    let rejected = 0;
    for (const copy of [invalidArchive, invalidCurrency, invalidAudio]) {
      try { await db.restore(copy); } catch { rejected++; }
    }
    const after = await db.backup();
    return { rejected, unchanged: JSON.stringify(after.base) === JSON.stringify(original.base) && JSON.stringify(after.outbox) === JSON.stringify(original.outbox) };
  });
  expect(result).toEqual({ rejected: 3, unchanged: true });
});
