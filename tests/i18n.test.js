import { test } from "node:test";
import assert from "node:assert/strict";
import { getLanguage, setLanguage, t, translateFileError, subscribeLanguage } from "../backend/web/i18n.js";
import { formatMoney, dayLabel, initialState } from "../backend/web/model.js";
import { missingLiterals } from "../scripts/i18n-audit.mjs";

test("translation audit catches literal branches and preserves named parameters", () => {
  const source = 't(flag ? "Удалить" : "Отмена"); const labels = ["Сохранить"]; t("Записей: {count}", {count: 2});';
  assert.deepEqual(missingLiterals(source, { "Удалить": "Delete", "Сохранить": "Save" }).map(x => x.source), ["Отмена", "Записей: {count}"]);
  assert.deepEqual(missingLiterals('t("Unknown"); const label = "Фото чека · ";'), []);
});

test("language switching translates known text but preserves missing keys and parameters", () => {
  setLanguage("ru");
  assert.equal(t("Сохранить"), "Сохранить");
  setLanguage("en");
  assert.equal(t("Сохранить"), "Save");
  assert.equal(t("Записей: {count}", { count: 3 }), "Entries: 3");
  assert.equal(t("Неизвестная строка"), "Неизвестная строка");
  assert.equal(t("constructor"), "constructor");
  assert.equal(t("toString"), "toString");
  assert.equal(t("Записей: {count}"), "Entries: {count}");
  setLanguage("ru");
});

test("invalid languages are rejected and listeners can unsubscribe", () => {
  let changes = 0;
  const unsubscribe = subscribeLanguage(() => changes++);
  setLanguage("en");
  assert.throws(() => setLanguage("fr"));
  assert.equal(getLanguage(), "en");
  unsubscribe();
  setLanguage("ru");
  assert.equal(changes, 1);
});

test("money and dates follow language without changing currency or saved names", () => {
  setLanguage("ru");
  const oldBook = initialState();
  assert.equal(formatMoney(1025, "USD"), "10,25 USD");
  setLanguage("en");
  assert.equal(formatMoney(1025, "USD"), "USD 10.25");
  assert.equal(dayLabel("2026-01-01"), "1 January 2026");
  assert.equal(initialState().accounts[0].name, "Main");
  assert.equal(oldBook.accounts[0].name, "Основной");
  setLanguage("ru");
  assert.equal(formatMoney(1025, "USD"), "10,25 USD");
});

test("XLSX row errors translate system text without changing sheet names or unknown reasons", () => {
  setLanguage("en");
  assert.equal(translateFileError("Расходы, строка 5: неверная дата"), "Расходы, row 5: invalid date");
  assert.equal(translateFileError("Расходы, строка 7: Счет пользователя"), "Расходы, row 7: Счет пользователя");
  assert.equal(translateFileError("Не совпадают заголовки листа Доходы"), "Headers do not match for sheet Доходы");
  setLanguage("ru");
  assert.equal(translateFileError("Расходы, строка 5: неверная дата"), "Расходы, строка 5: неверная дата");
});

test("XLSX currency errors preserve arbitrary account names and interpolate only system fields", () => {
  setLanguage("en");
  assert.equal(translateFileError("Расходы, строка 3: неизвестная валюта счета: XYZ"), "Расходы, row 3: unknown account currency: XYZ");
  assert.equal(translateFileError("Переводы, строка 9: валюта счета Сохранить не совпадает: USD и EUR"), "Переводы, row 9: account currency mismatch for Сохранить: USD and EUR");
  assert.equal(translateFileError("Доходы, строка 4: Сумма должна быть положительной, не больше двух знаков после точки"), "Доходы, row 4: Amount must be positive with no more than two decimal places");
  setLanguage("ru");
  assert.equal(translateFileError("неизвестная валюта счета: XYZ"), "неизвестная валюта счета: XYZ");
});

test("atomic sync errors translate known status and nested reason without changing unknown text", () => {
  setLanguage("en");
  assert.equal(translateFileError("Изменения не применены: invalid Счет недоступен"), "Changes not applied: invalid Account unavailable");
  assert.equal(translateFileError("Изменения не применены: conflict "), "Changes not applied: conflict ");
  assert.equal(translateFileError("Изменения не применены: other Счет недоступен"), "Изменения не применены: other Счет недоступен");
  setLanguage("ru");
  assert.equal(translateFileError("Изменения не применены: invalid Счет недоступен"), "Изменения не применены: invalid Счет недоступен");
});

test("assistant category validation errors translate their prefix without rewriting unknown details", () => {
  setLanguage("en");
  assert.equal(translateFileError("Для новой категории нужно уточнить операцию: Счет недоступен"), "The entry for the new category needs clarification: Account unavailable");
  assert.equal(translateFileError("Для новой категории нужно уточнить операцию: Иной счет"), "The entry for the new category needs clarification: Иной счет");
  setLanguage("ru");
  assert.equal(translateFileError("Для новой категории нужно уточнить операцию: Счет недоступен"), "Для новой категории нужно уточнить операцию: Счет недоступен");
});

test("blocked storage does not prevent switching languages", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw Error("blocked"); } });
  try { setLanguage("en"); assert.equal(getLanguage(), "en"); setLanguage("ru"); }
  finally { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; }
});
