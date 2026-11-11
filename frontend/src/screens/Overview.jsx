import { t } from "/i18n.js";
import { useState } from "react";
import {
  cents,
  currencyCode,
  formatMoney,
  summarizeByCurrency,
  periodEntries,
  colors,
} from "/model.js";
import { useFinance } from "../FinanceProvider.jsx";
import { Icon, ColoredIcon } from "../components/ui.jsx";
import Period from "../components/Period.jsx";

export default function Overview({ onEntry }) {
  const { current, period, filters, setFilters } = useFinance();
  const [ringKind, setRingKind] = useState("expense");
  const [currency, setCurrency] = useState("RUB");
  const entries = periodEntries(current.state.entries, period, filters.account);
  const summary = summarizeByCurrency(current.state, entries);
  const codes = Object.keys(summary.totals);
  const selectedCurrency = codes.includes(currency)
    ? currency
    : codes[0] || "RUB";
  const totals = summary.totals[selectedCurrency] || {
    income: 0,
    expense: 0,
    categories: {},
  };
  const rub = (value) => formatMoney(value, selectedCurrency);
  const groups = new Map();
  for (const entry of entries)
    if (
      entry.kind === ringKind &&
      currencyCode(entry.currency) === selectedCurrency
    )
      groups.set(
        entry.categoryId,
        (groups.get(entry.categoryId) || 0) + cents(entry.amount),
      );
  const sorted = [...groups].sort((a, b) => b[1] - a[1]);
  const total = totals[ringKind];
  const label = t(ringKind === "expense" ? "Расходы" : "Доходы");
  const category = (id) =>
    current.state.categories.find((item) => item.id === id);
  let offset = 0;
  const arcs = sorted.map(([id, sum]) => {
    const share = total ? (sum / total) * 100 : 0;
    const color = category(id)?.color || colors[0];
    const arc = (
      <circle
        key={id}
        cx="60"
        cy="60"
        r="48"
        pathLength="100"
        stroke={/^#[0-9a-f]{6}$/i.test(color) ? color : colors[0]}
        strokeDasharray={`${Math.max(0, share - Math.min(0.8, share / 8))} 100`}
        strokeDashoffset={-offset}
      >
        <title>
          {category(id)?.name || t("Категория")}: {rub(sum)} ·{" "}
          {Math.round(share)}%
        </title>
      </circle>
    );
    offset += share;
    return arc;
  });
  return (
    <div className="overview">
      <h1 className="visually-hidden">{t("Ваши финансы")}</h1>
      <div className="overview-kind">
        {[
          ["expense", "Расходы"],
          ["income", "Доходы"],
        ].map(([kind, name]) => (
          <button
            key={kind}
            type="button"
            data-action={`ring-${kind}`}
            className={ringKind === kind ? "active" : ""}
            onClick={() => setRingKind(kind)}
          >
            {t(name)}
          </button>
        ))}
      </div>
      <section className="overview-chart-panel">
        <Period shortcuts />
        {codes.length > 1 && (
          <label>
            {t("Валюта")}
            <select
              value={selectedCurrency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {codes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="overview-ring">
          <div
            className="expense-chart"
            role="img"
            aria-label={t("{label} по категориям: {total}", {
              label,
              total: rub(total),
            })}
          >
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle className="chart-track" cx="60" cy="60" r="48" />
              <circle
                className="chart-guide"
                cx="60"
                cy="60"
                r="35"
                strokeDasharray="3 2"
              />
              {arcs}
            </svg>
            <div className="chart-total">
              <span className="small">{label}</span>
              <strong>{rub(total)}</strong>
            </div>
          </div>
          <button
            type="button"
            className="chart-add"
            data-action="new-entry"
            aria-label={t("Добавить")}
            onClick={() => onEntry({})}
          >
            <Icon name="plus" />
          </button>
        </div>
        <div className="period-totals">
          <span>
            {t("Доходы")} <strong>{rub(totals.income)}</strong>
          </span>
          <span>
            {t("Расходы")} <strong>{rub(totals.expense)}</strong>
          </span>
        </div>
      </section>
      <section
        className="overview-categories"
        aria-label={t("{label} по категориям", { label })}
      >
        {sorted.length ? (
          sorted.map(([id, sum]) => (
            <button
              key={id}
              type="button"
              className="category-row"
              data-action="category-filter"
              data-id={id}
              onClick={() => {
                setFilters((previous) => ({
                  ...previous,
                  category: id,
                  query: "",
                  kind: ringKind,
                }));
                location.hash = "entries";
              }}
            >
              <ColoredIcon category={category(id)} />
              <span className="category-label">
                {category(id)?.name || t("Категория")}
              </span>
              <span className="category-percent">
                {Math.round((sum / total) * 100)}%
              </span>
              <span className="cat-sum">{rub(sum)}</span>
            </button>
          ))
        ) : (
          <p className="small chart-empty">
            {t(
              ringKind === "expense"
                ? "Расходов за этот период нет"
                : "Доходов за этот период нет",
            )}
          </p>
        )}
      </section>
    </div>
  );
}
