import { test } from "node:test";
import assert from "node:assert/strict";
import { paths, iconNames, iconGroups, categoryIcons } from "../backend/web/icons.js";
import {
  cents,
  decimal,
  initialState,
  summarize,
  validateEntry,
  escapeHTML,
  entrySignature,
  periodRange, shiftPeriod, periodEntries,
  assistantContext,
} from "../backend/web/model.js";
test("assistant context bounds UTF-8 content and keeps only the current four turns", () => {
  const context = assistantContext(Array.from({length:20},(_,i)=>({role:i%2?"assistant":"user",content:"я".repeat(4000)})));
  assert.ok(context.length<=4);
  assert.ok(new TextEncoder().encode(context.map(x=>x.content).join("")).length<=8192);
  assert.equal(context.at(-1).role,"assistant");
});
test("periods use inclusive calendar boundaries across weeks and leap years", () => {
  assert.deepEqual(periodRange("week", "2026-01-01"), { mode: "week", anchor: "2026-01-01", from: "2025-12-29", to: "2026-01-04" });
  assert.equal(periodRange("month", "2024-02-29").to, "2024-02-29");
  assert.equal(shiftPeriod(periodRange("month", "2026-01-31"), 1).to, "2026-02-28");
  assert.equal(periodRange("year", "2026-11-02").from, "2026-01-01");
  assert.throws(() => periodRange("range", "2026-01-01", "2026-02-02", "2026-01-01"));
  const entries = [{ date: "2026-01-01", accountId: "a" }, { date: "2026-01-02", accountId: "b", toAccountId: "a" }, { date: "2026-01-02", accountId: "a", deleted: true }];
  assert.equal(periodEntries(entries, periodRange("range", "2026-01-01", "2026-01-01", "2026-01-02"), "a").length, 2);
});
test("all category icons belong to one named group and have vector artwork", () => {
  assert.equal(iconGroups.length, 12);
  assert.equal(categoryIcons.length, 166);
  assert.equal(new Set(categoryIcons).size, categoryIcons.length);
  for (const id of categoryIcons) {
    assert.ok(iconNames[id], `Missing label: ${id}`);
    assert.ok(paths[id], `Missing artwork: ${id}`);
  }
});
test("money stays exact in minor units", () => {
  assert.equal(cents("0,29"), 29);
  assert.equal(cents("999999999.99"), 99999999999);
  assert.equal(decimal(-12345), "-123.45");
  for (const s of ["1e3", "0.001", "1000000000", "NaN", ""])
    assert.throws(() => cents(s));
  assert.equal(decimal(cents("123.4")), "123.40");
});

test("duplicate identity compares money by value", () => {
  const entry = { kind: "expense", amount: "100", date: "2026-10-29" };
  for (const amount of ["100.0", "100.00"])
    assert.equal(entrySignature(entry), entrySignature({ ...entry, amount }));
  assert.notEqual(entrySignature(entry), entrySignature({ ...entry, amount: "100.01" }));
});
test("transfer affects balances but not income or expense", () => {
  const s = initialState();
  s.accounts.push({ id: "second", opening: "10.00" });
  const entry = {
    kind: "transfer",
    amount: "5.01",
    accountId: s.accounts[0].id,
    toAccountId: "second",
    date: "2026-10-29",
    note: "",
    tags: "",
  };
  validateEntry(entry, s);
  const totals = summarize(s, [entry]);
  assert.equal(totals.income, 0);
  assert.equal(totals.expense, 0);
  assert.equal(totals.balances.second, 1501);
  assert.equal(totals.balances[s.accounts[0].id], -501);
  assert.throws(() =>
    validateEntry({ ...entry, toAccountId: entry.accountId }, s),
  );
});
test("invalid date and category do not become operations", () => {
  const s = initialState();
  const entry = {
    kind: "expense",
    amount: "1.00",
    accountId: s.accounts[0].id,
    categoryId: s.categories[0].id,
    date: "2026-02-31",
    note: "",
    tags: "",
  };
  assert.throws(() => validateEntry(entry, s));
  assert.throws(() =>
    validateEntry({ ...entry, date: "2026-10-29", categoryId: "foreign" }, s),
  );
  assert.throws(() =>
    validateEntry({ ...entry, date: "2026-10-29", amount: "-1" }, s),
  );
});
test("user-controlled text is escaped for HTML", () => {
  assert.equal(
    escapeHTML('<img onerror="x">'),
    "&lt;img onerror=&quot;x&quot;&gt;",
  );
});

test("time is optional, strict and part of duplicate identity", () => {
  const state = initialState();
  const entry = {
    id: "sample",
    kind: "expense",
    amount: "1.00",
    accountId: state.accounts[0].id,
    categoryId: state.categories[0].id,
    date: "2026-10-29",
    note: "",
    tags: "",
  };
  for (const time of [undefined, "", "00:00", "09:05", "23:59"])
    assert.doesNotThrow(() => validateEntry({ ...entry, time }, state));
  for (const time of ["24:00", "12:60", "7:30", "09:05:00"])
    assert.throws(() => validateEntry({ ...entry, time }, state));
  assert.notEqual(
    entrySignature({ ...entry, time: "10:00" }),
    entrySignature({ ...entry, time: "10:01" }),
  );
  assert.equal(
    entrySignature(entry),
    entrySignature({ ...entry, time: "", toAccountId: "" }),
  );
});
