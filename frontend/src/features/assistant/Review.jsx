import { t } from "/i18n.js";
import { useRef, useState } from "react";
import {
  cents,
  currencyCode,
  decimal,
  formatMoney,
  validateEntry,
} from "/model.js";
import { Dialog } from "../../components/ui.jsx";
import { finishAssistant } from "../../services/assistant.js";

export default function Review({ saved, current, close, fail }) {
  const [entries, setEntries] = useState(() =>
    saved.result.entries.map((e) => ({ ...e })),
  );
  const [busy, setBusy] = useState(false),
    saving = useRef(false);
  const categories = [
    ...current.state.categories,
    ...(saved.pendingCategories || []),
  ];
  const change = (index, patch) =>
    setEntries((rows) =>
      rows.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    );
  const sameCurrency = entries.every(
    (e) => currencyCode(e.currency) === currencyCode(entries[0]?.currency),
  );
  const one = () =>
    setEntries((rows) => [
      {
        ...rows[0],
        amount:
          saved.result.total ||
          decimal(rows.reduce((sum, e) => sum + cents(e.amount), 0)),
        note: t("Чек одной суммой"),
      },
    ]);
  const submit = async (event) => {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const normalized = entries.map((e) => ({
        ...e,
        amount: decimal(cents(e.amount)),
        ...(e.toAmount ? { toAmount: decimal(cents(e.toAmount)) } : {}),
        note: e.note || "",
        tags: e.tags || "",
      }));
      for (const e of normalized)
        validateEntry(e, { ...current.state, categories });
      if (
        saved.result.total &&
        (!sameCurrency ||
          normalized.some(
            (e) =>
              currencyCode(e.currency) !==
              currencyCode(saved.result.receiptCurrency),
          ))
      )
        throw Error(t("Валюта операций не совпадает с валютой итога чека"));
      if (
        saved.result.total &&
        normalized.reduce((sum, e) => sum + cents(e.amount), 0) !==
          cents(saved.result.total)
      )
        throw Error(
          t("Сумма строк не совпадает с итогом чека: {total}", {
            total: formatMoney(
              cents(saved.result.total),
              saved.result.receiptCurrency,
            ),
          }),
        );
      await finishAssistant(
        { ...saved, ownerId: current.settings.userId },
        normalized,
        saved.pendingCategories || [],
        { foreground: true },
      );
      close();
    } catch (error) {
      fail(new Error(t(error.message)));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t(
        saved.result.receipt ? "Проверка чека" : "Подготовленные операции",
      )}
      onClose={() => {
        if (!saving.current) close();
      }}
    >
      <form onSubmit={submit}>
        {saved.result.receipt &&
          entries.length > 1 &&
          sameCurrency &&
          (!saved.result.total ||
            currencyCode(saved.result.receiptCurrency) ===
              currencyCode(entries[0].currency)) && (
            <button
              type="button"
              className="secondary full"
              data-action="receipt-one"
              onClick={one}
            >
              {t("Сохранить одной суммой")}
            </button>
          )}
        <div className="receipt-lines">
          {entries.map((e, i) => (
            <div key={e.id}>
              <p>{e.note || t("Операция {number}", { number: i + 1 })}</p>
              <label htmlFor={`review-amount-${i}`}>
                {t("Сумма ({currency})", {
                  currency: currencyCode(e.currency),
                })}
              </label>
              <input
                id={`review-amount-${i}`}
                inputMode="decimal"
                value={e.amount}
                required
                onChange={(event) => change(i, { amount: event.target.value })}
              />
              <div className="form-grid">
                <div>
                  <label htmlFor={`review-date-${i}`}>{t("Дата")}</label>
                  <input
                    id={`review-date-${i}`}
                    type="date"
                    required
                    value={e.date}
                    onChange={(event) =>
                      change(i, { date: event.target.value })
                    }
                  />
                </div>
                <div>
                  <label htmlFor={`review-time-${i}`}>{t("Время")}</label>
                  <input
                    id={`review-time-${i}`}
                    type="time"
                    value={e.time || ""}
                    onChange={(event) =>
                      change(i, { time: event.target.value })
                    }
                  />
                </div>
              </div>
              <label htmlFor={`review-account-${i}`}>
                {t(e.kind === "transfer" ? "Откуда" : "Счет")}
              </label>
              <select
                id={`review-account-${i}`}
                value={e.accountId || ""}
                onChange={(event) => {
                  const account = current.state.accounts.find(
                    (a) => a.id === event.target.value,
                  );
                  const currency = account
                    ? currencyCode(account.currency)
                    : currencyCode(e.currency);
                  change(i, {
                    accountId: event.target.value,
                    currency,
                    ...(currency !== currencyCode(e.currency)
                      ? { amount: "", toAmount: "" }
                      : {}),
                  });
                }}
              >
                <option value="">{t("Выберите счет")}</option>
                {current.state.accounts
                  .filter((x) => !x.deleted)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} ({currencyCode(x.currency)})
                    </option>
                  ))}
              </select>
              {e.kind === "transfer" ? (
                <>
                  <label htmlFor={`review-to-${i}`}>{t("Куда")}</label>
                  <select
                    id={`review-to-${i}`}
                    value={e.toAccountId || ""}
                    onChange={(event) => {
                      const account = current.state.accounts.find(
                        (a) => a.id === event.target.value,
                      );
                      const toCurrency = account
                        ? currencyCode(account.currency)
                        : "";
                      change(i, {
                        toAccountId: event.target.value,
                        toCurrency,
                        toAmount: "",
                      });
                    }}
                  >
                    <option value="">{t("Выберите счет")}</option>
                    {current.state.accounts
                      .filter((x) => !x.deleted)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name} ({currencyCode(x.currency)})
                        </option>
                      ))}
                  </select>
                  {e.toAccountId &&
                    currencyCode(e.currency) !== currencyCode(e.toCurrency) && (
                      <>
                        <label htmlFor={`review-to-amount-${i}`}>
                          {t("Сумма зачисления ({currency})", {
                            currency: currencyCode(e.toCurrency),
                          })}
                        </label>
                        <input
                          id={`review-to-amount-${i}`}
                          inputMode="decimal"
                          required
                          value={e.toAmount || ""}
                          onChange={(event) =>
                            change(i, { toAmount: event.target.value })
                          }
                        />
                      </>
                    )}
                </>
              ) : (
                <>
                  <label htmlFor={`review-category-${i}`}>
                    {t("Категория")}
                  </label>
                  <select
                    id={`review-category-${i}`}
                    value={e.categoryId || ""}
                    onChange={(event) =>
                      change(i, { categoryId: event.target.value })
                    }
                  >
                    <option value="">{t("Выберите категорию")}</option>
                    {categories
                      .filter((x) => !x.deleted && x.kind === e.kind)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="form-actions">
          <button className="primary" disabled={busy} type="submit">
            {t(
              saved.pendingCategories?.length
                ? "Создать категорию и сохранить ({count})"
                : "Сохранить ({count})",
              { count: entries.length },
            )}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
