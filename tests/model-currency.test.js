import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, summarize, summarizeByCurrency, validateEntry, entrySignature, currencyCode } from "../backend/web/model.js";

const state = () => {
  const s = initialState();
  s.accounts[0].opening = "10000.00";
  s.accounts.push({ id: "usd", name: "USD", currency: "USD", opening: "0.00" });
  return s;
};
const transfer = () => ({ kind:"transfer", amount:"9000.00", currency:"RUB", accountId:initialState().accounts[0].id, toAccountId:"usd", toAmount:"100.00", toCurrency:"USD", date:"2026-11-07", note:"", tags:"" });

test("currency defaults only missing codes to RUB and rejects unknown codes", () => {
  assert.equal(currencyCode(undefined), "RUB");
  for (const c of ["RUB","USD","EUR","CNY","GBP","CHF","GEL","TRY","AED","KZT","BYN","UAH"]) assert.equal(currencyCode(c), c);
  for (const c of ["JPY", "usd", "ZZZ", false, 0]) assert.throws(() => currencyCode(c));
});

test("foreign transfers use credited amount and never mix currency totals", () => {
  const s = state(), t = transfer();
  const expense = { kind:"expense", amount:"10.25", currency:"USD", accountId:"usd", categoryId:s.categories[0].id, date:"2026-11-07", note:"", tags:"" };
  validateEntry(t, s); validateEntry(expense, s);
  const result = summarizeByCurrency(s, [t, expense]);
  assert.equal(result.balances[s.accounts[0].id], 100000);
  assert.equal(result.balances.usd, 8975);
  assert.equal(result.totals.RUB.expense, 0);
  assert.equal(result.totals.USD.expense, 1025);
  assert.equal(result.totals.USD.income, 0);
  assert.throws(() => summarize(s, [t, expense]));
});

test("archived accounts seed no currency totals, yet keep their history", () => {
  const s = state();
  s.accounts[1].deleted = true;
  assert.deepEqual(Object.keys(summarizeByCurrency(s, []).totals), ["RUB"]);
  const entry = { kind:"expense", amount:"5.00", currency:"USD", accountId:"usd", categoryId:s.categories[0].id, date:"2026-11-07", note:"", tags:"" };
  const history = summarizeByCurrency(s, [entry]);
  assert.deepEqual(Object.keys(history.totals).sort(), ["RUB","USD"]);
  assert.equal(history.totals.USD.expense, 500);
});

test("a foreign transfer requires its destination amount and currency", () => {
  const s = state(), t = transfer();
  for (const patch of [{toAmount:undefined}, {toCurrency:undefined}, {toAmount:"0"}, {toAmount:"-1"}, {currency:"USD"}, {toCurrency:"RUB"}]) assert.throws(() => validateEntry({...t,...patch},s));
});

test("same-currency transfer can omit destination metadata even outside RUB", () => {
  const s=state(); s.accounts.push({id:"usd2",currency:"USD",opening:"0.00"});
  const t={...transfer(),accountId:"usd",currency:"USD",toAccountId:"usd2",amount:"1.00",toCurrency:undefined,toAmount:undefined};
  assert.doesNotThrow(()=>validateEntry(t,s));
  assert.equal(summarizeByCurrency(s,[t]).balances.usd2,100);
  assert.equal(entrySignature(t),entrySignature({...t,toCurrency:"USD",toAmount:"1.00"}));
});

test("legacy RUB transfers stay equal and duplicate signatures normalize old formats", () => {
  const s=initialState();s.accounts.push({id:"other",opening:"0.00"});
  const t={kind:"transfer",amount:"5",accountId:s.accounts[0].id,toAccountId:"other",date:"2026-11-07",note:"",tags:""};
  validateEntry(t,s);
  assert.equal(entrySignature(t),entrySignature({...t,amount:"5.00",currency:"RUB",toCurrency:"RUB",toAmount:"5.00"}));
  assert.throws(()=>validateEntry({...t,toAmount:"4.00",toCurrency:"RUB"},s));
  assert.throws(()=>summarizeByCurrency(s,[{...t,toAmount:"4.00",toCurrency:"RUB"}]));
  assert.throws(()=>summarizeByCurrency(s,[{...t,toAmount:"-1.00",toCurrency:"RUB"}]));
  assert.notEqual(entrySignature({...t,toAmount:"5.00"}),entrySignature({...t,toAmount:"6.00"}));
});
