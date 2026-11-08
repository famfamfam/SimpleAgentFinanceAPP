import { categoryIcons } from "./icons.js";
export const accountId = "00000000-0000-4000-8000-000000000001";
export const categoryNames = [
  "Продукты",
  "Кафе",
  "Транспорт",
  "Дом",
  "Здоровье",
  "Покупки",
  "Досуг",
  "Другое",
  "Зарплата",
  "Другие доходы",
  "Образование",
  "ЖКХ",
  "Жилье",
  "Маркетплейсы",
  "Одежда",
  "Животина",
];
export const colors = [
  "#7dad43",
  "#b08bc0",
  "#6598c5",
  "#ff8b36",
  "#ff3e36",
  "#ffbd1c",
  "#58b8a2",
  "#8e9782",
  "#7dad43",
  "#58b8a2",
  "#6598c5",
  "#7dad43",
  "#ff4550",
  "#ffbd1c",
  "#ffbd1c",
  "#ffbd1c",
];
export const icons = ["basket","cup","bus","home","heart","bag","wallet","dots","wallet","plus","book","tent","tag","parcel","shirt","paw", ...categoryIcons];
export function initialState() {
  return {
    accounts: [
      {
        id: accountId,
        name: "Основной",
        opening: "0.00",
        version: 1,
        deleted: false,
      },
    ],
    categories: categoryNames.map((name, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 2).padStart(12, "0")}`,
      name,
      kind: i === 8 || i === 9 ? "income" : "expense",
      color: colors[i],
      icon: icons[i],
      version: 1,
      deleted: false,
    })),
    entries: [],
  };
}
export function cents(value) {
  const s = String(value).trim().replace(",", ".");
  if (!/^-?(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(s))
    throw Error("Сумма до 999 999 999,99, не больше двух знаков после запятой");
  const [whole, fraction = ""] = s.replace("-", "").split(".");
  return (
    (Number(whole) * 100 + Number((fraction + "00").slice(0, 2))) *
    (s.startsWith("-") ? -1 : 1)
  );
}
export function decimal(n) {
  if (!Number.isSafeInteger(n)) throw Error("Слишком большая сумма");
  return `${n < 0 ? "-" : ""}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, "0")}`;
}
export const currencies = ["RUB", "USD", "EUR", "CNY", "GBP", "CHF", "GEL", "TRY", "AED", "KZT", "BYN", "UAH"];
export function currencyCode(value) {
  const code = value == null || value === "" ? "RUB" : value;
  if (!currencies.includes(code)) throw Error("Неподдерживаемая валюта");
  return code;
}
const currencyFormats = new Map();
export function formatMoney(value, code = "RUB") {
  code = currencyCode(code);
  if (!currencyFormats.has(code)) currencyFormats.set(code, new Intl.NumberFormat("ru-RU", {
    style: "currency", currency: code, currencyDisplay: code === "RUB" ? "symbol" : "code", maximumFractionDigits: 2, minimumFractionDigits: 0,
  }));
  return currencyFormats.get(code).format(value / 100);
}
export function rub(value) { return formatMoney(value, "RUB"); }
export function clock() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const dateString = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function calendarDate(value) {
  const date = new Date(value + "T12:00:00");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || dateString(date) !== value)
    throw Error("Проверьте даты периода");
  return date;
}
export function periodRange(mode = "month", anchor = today(), from = "", to = "") {
  if (mode === "all") return { mode, anchor, from: "", to: "" };
  if (mode === "range") {
    calendarDate(from); calendarDate(to);
    if (from > to) throw Error("Начало периода должно быть не позже окончания");
    return { mode, anchor, from, to };
  }
  const start = calendarDate(anchor), end = calendarDate(anchor);
  switch (mode) {
    case "day": break;
    case "week":
      start.setDate(start.getDate() - (start.getDay() + 6) % 7);
      end.setTime(start.getTime()); end.setDate(end.getDate() + 6); break;
    case "month": start.setDate(1); end.setMonth(end.getMonth() + 1, 0); break;
    case "year": start.setMonth(0, 1); end.setMonth(11, 31); break;
    default: throw Error("Неверный период");
  }
  return { mode, anchor, from: dateString(start), to: dateString(end) };
}
export function shiftPeriod(period, direction) {
  if (period.mode === "all") return period;
  const date = calendarDate(period.anchor);
  if (period.mode === "month") { date.setDate(15); date.setMonth(date.getMonth() + direction); }
  else if (period.mode === "year") { date.setMonth(0, 1); date.setFullYear(date.getFullYear() + direction); }
  else if (period.mode === "range") {
    const start = calendarDate(period.from), end = calendarDate(period.to);
    const days = Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000) + 1;
    start.setDate(start.getDate() + direction * days); end.setDate(end.getDate() + direction * days);
    return periodRange("range", dateString(start), dateString(start), dateString(end));
  } else date.setDate(date.getDate() + direction * (period.mode === "week" ? 7 : 1));
  return periodRange(period.mode, dateString(date));
}
export function periodEntries(entries, period, account = "") {
  return entries.filter(e => !e.deleted && (!period.from || e.date >= period.from) &&
    (!period.to || e.date <= period.to) && (!account || e.accountId === account || e.toAccountId === account));
}
export function assistantContext(turns) {
  const encoder = new TextEncoder();
  const bounded = turns.slice(-4).map(turn => {
    const bytes = encoder.encode(String(turn.content));
    const content = bytes.length > 8192 ? new TextDecoder().decode(bytes.slice(0,8190)) : String(turn.content);
    return { role:turn.role, content };
  });
  while (bounded.length && encoder.encode(bounded.map(t => t.content).join("")).length > 8192) bounded.shift();
  return bounded;
}
export async function derivedID(seed,index) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(seed+":"+String.fromCodePoint(index)));
  const hex=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,32).split("");
  hex[12]="4";hex[16]="8";const text=hex.join("");
  return `${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`;
}
export function bufferBase64(buffer) {
  let text="";const bytes=new Uint8Array(buffer);
  for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
}
export const base64Buffer = text => Uint8Array.from(atob(text),x=>x.charCodeAt(0)).buffer;
export function dayLabel(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(date + "T12:00:00"));
}
export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function summarizeByCurrency(state, entries) {
  const accounts = Object.fromEntries(state.accounts.map(a => [a.id, a]));
  const balances = Object.fromEntries(state.accounts.map(a => [a.id, cents(a.opening)]));
  const totals = {};
  const group = code => totals[code] ||= { income: 0, expense: 0, categories: {} };
  for (const a of state.accounts) if (!a.deleted) group(currencyCode(a.currency));
  for (const e of entries) {
    if (e.deleted) continue;
    const source = accounts[e.accountId];
    if (!source) throw Error("Счет операции недоступен");
    const code = currencyCode(source.currency);
    if (currencyCode(e.currency) !== code) throw Error("Валюта операции не совпадает с валютой счета");
    const n = cents(e.amount), total = group(code);
    if (e.kind === "income") {
      total.income += n;
      balances[e.accountId] += n;
    } else if (e.kind === "expense") {
      total.expense += n;
      balances[e.accountId] -= n;
      total.categories[e.categoryId] = (total.categories[e.categoryId] || 0) + n;
    } else if (e.kind === "transfer") {
      const target = accounts[e.toAccountId];
      if (!target) throw Error("Счет перевода недоступен");
      const targetCode = currencyCode(target.currency);
      if ((e.toCurrency ? currencyCode(e.toCurrency) !== targetCode : code !== targetCode) || (code !== targetCode && !e.toAmount))
        throw Error("Проверьте сумму и валюту зачисления");
      const credited = cents(e.toAmount || e.amount);
      if (n <= 0 || credited <= 0 || (code === targetCode && credited !== n))
        throw Error("Проверьте сумму зачисления");
      balances[e.accountId] -= n;
      balances[e.toAccountId] += credited;
    } else throw Error("Неверный тип операции");
  }
  return { balances, totals };
}
export function summarize(state, entries) {
  const { balances, totals } = summarizeByCurrency(state, entries);
  const codes = Object.keys(totals);
  if (codes.length > 1) throw Error("Выберите валюту для итогов");
  return { balances, ...(totals[codes[0]] || { income: 0, expense: 0, categories: {} }) };
}
export function validateEntry(e, state) {
  if (cents(e.amount) <= 0) throw Error("Сумма должна быть больше нуля");
  if (!["income", "expense", "transfer"].includes(e.kind))
    throw Error("Неверный тип операции");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(e.date) ||
    new Date(e.date + "T12:00:00Z").toISOString().slice(0, 10) !== e.date
  )
    throw Error("Проверьте дату");
  if (e.time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(e.time))
    throw Error("Укажите время в формате ЧЧ:ММ");
  const source = state.accounts.find(a => a.id === e.accountId && !a.deleted);
  if (!source) throw Error("Выберите счет");
  const sourceCode = currencyCode(source.currency);
  if (currencyCode(e.currency) !== sourceCode) throw Error("Валюта операции не совпадает с валютой счета");
  const previous = e.id && state.entries?.find(item => item.id === e.id);
  if (previous && currencyCode(previous.currency) !== sourceCode)
    throw Error("Нельзя изменить валюту существующей операции");
  if (e.kind === "transfer") {
    const target = state.accounts.find(a => a.id === e.toAccountId && !a.deleted);
    if (e.accountId === e.toAccountId || !target) throw Error("Выберите другой счет перевода");
    const targetCode = currencyCode(target.currency);
    if (e.toCurrency ? currencyCode(e.toCurrency) !== targetCode : sourceCode !== targetCode) throw Error("Валюта зачисления не совпадает с валютой счета");
    if (sourceCode !== targetCode && !e.toAmount) throw Error("Укажите сумму зачисления");
    const targetAmount = cents(e.toAmount || e.amount);
    if (targetAmount <= 0 || (sourceCode === targetCode && targetAmount !== cents(e.amount)))
      throw Error("Проверьте сумму зачисления");
  } else if (e.toAmount || e.toCurrency || e.toAccountId) {
    throw Error("Второй счет и сумма допустимы только у перевода");
  } else if (
    !state.categories.some(
      (c) => c.id === e.categoryId && c.kind === e.kind && !c.deleted,
    )
  )
    throw Error("Выберите категорию");
  if (e.note.length > 4096 || e.tags.length > 512)
    throw Error("Слишком длинный комментарий или теги");
}

export function entrySignature(entry) {
  const currency = currencyCode(entry.currency);
  const transfer = entry.kind === "transfer";
  const toCurrency = transfer ? (entry.toCurrency ? currencyCode(entry.toCurrency) : currency) : "";
  const toAmount = transfer && (entry.toAmount || (currency === toCurrency && entry.amount));
  return [
    entry.kind || "", decimal(cents(entry.amount)), currency, entry.accountId || "",
    entry.toAccountId || "", toCurrency, toAmount ? decimal(cents(toAmount)) : "",
    entry.categoryId || "", entry.date || "", entry.time || "", entry.note || "", entry.tags || "",
  ].join("\0");
}
