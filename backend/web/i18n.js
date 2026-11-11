import english from "./en.js";

const key = "finance-language";
const listeners = new Set();
let language = "ru";
try {
  if (globalThis.localStorage?.getItem(key) === "en") language = "en";
} catch {}

export const getLanguage = () => language;
export const getLocale = () => language === "en" ? "en-GB" : "ru-RU";
export function setLanguage(value) {
  if (value !== "ru" && value !== "en") throw Error("Unsupported language");
  if (language === value) return;
  language = value;
  try { globalThis.localStorage?.setItem(key, value); } catch {}
  for (const listener of listeners) listener();
}
export function subscribeLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("storage", event => {
    if (event.key !== key || !["ru", "en"].includes(event.newValue) || event.newValue === language) return;
    language = event.newValue;
    for (const listener of listeners) listener();
  });
}
export function translateFileError(message) {
  const row = /^(Расходы|Доходы|Переводы), строка (\d+): ([\s\S]*)$/.exec(message);
  if (row) return t("{sheet}, строка {row}: {reason}", { sheet: row[1], row: row[2], reason: translateFileReason(row[3]) });
  const headers = /^Не совпадают заголовки листа (Расходы|Доходы|Переводы)$/.exec(message);
  if (headers) return t("Не совпадают заголовки листа {sheet}", { sheet: headers[1] });
  const category = /^Для новой категории нужно уточнить операцию: ([\s\S]*)$/.exec(message);
  if (category) return t("Для новой категории нужно уточнить операцию: {reason}", { reason: t(category[1]) });
  const atomic = /^Изменения не применены: (invalid|conflict) ([\s\S]*)$/.exec(message);
  if (atomic) return t("Изменения не применены: {status} {reason}", { status: atomic[1], reason: t(atomic[2]) });
  return translateFileReason(message);
}
function translateFileReason(message) {
  const unknownCurrency = /^неизвестная валюта счета: ([\s\S]*)$/.exec(message);
  if (unknownCurrency) return t("неизвестная валюта счета: {currency}", { currency: unknownCurrency[1] });
  const currencyMismatch = /^валюта счета ([\s\S]*) не совпадает: ([A-Z]{3}) и ([A-Z]{3})$/.exec(message);
  if (currencyMismatch) return t("валюта счета {name} не совпадает: {existing} и {incoming}", { name: currencyMismatch[1], existing: currencyMismatch[2], incoming: currencyMismatch[3] });
  return t(message);
}
export function t(source, params = {}) {
  const message = language === "en" && Object.hasOwn(english, source) ? english[source] : source;
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
