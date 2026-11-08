import { useState } from "react";
import { periodRange, shiftPeriod, today, dayLabel } from "/model.js";
import { useFinance } from "../FinanceProvider.jsx";
import { Dialog, Icon } from "./ui.jsx";

export function periodLabel(value) {
  if (value.mode === "all") return "Всё время";
  if (value.mode === "month")
    return new Intl.DateTimeFormat("ru-RU", {
      month: "long",
      year: "numeric",
    }).format(new Date(value.from + "T12:00:00"));
  if (value.mode === "year") return value.from.slice(0, 4);
  if (value.from === value.to) return dayLabel(value.from);
  return `${value.from.split("-").reverse().join(".")} — ${value.to.split("-").reverse().join(".")}`;
}

export default function Period({ shortcuts = false }) {
  const { current, period, setPeriod, filters } = useFinance();
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = (mode = period.mode) => {
    setDraft({ ...period, mode });
    setError("");
  };
  const read = () =>
    periodRange(
      draft.mode,
      draft.anchor || today(),
      draft.from || today(),
      draft.to || today(),
    );
  const apply = async (event, exporting = false) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const chosen = read();
      if (exporting) {
        const request = new CustomEvent("finance-export", { detail: chosen });
        window.dispatchEvent(request);
        await request.promise;
      }
      setPeriod(chosen);
      setDraft(null);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  let preview = "";
  if (draft) {
    try {
      preview = periodLabel(read());
    } catch {
      preview = "Проверьте даты";
    }
  }
  const change = (event) =>
    setDraft({ ...draft, [event.target.name]: event.target.value });
  return (
    <>
      {shortcuts && (
        <div className="period-shortcuts" aria-label="Быстрый выбор периода">
          {[
            ["day", "День"],
            ["week", "Неделя"],
            ["month", "Месяц"],
            ["year", "Год"],
            ["range", "Период"],
          ].map(([mode, label]) => {
            const active =
              period.mode === mode ||
              (mode === "range" && period.mode === "all");
            return (
              <button
                key={mode}
                type="button"
                data-action="period-mode"
                data-mode={mode}
                className={active ? "active" : ""}
                aria-pressed={active}
                onClick={() =>
                  mode === "range"
                    ? open("range")
                    : setPeriod(periodRange(mode))
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <div className="period">
        {period.mode !== "all" && (
          <button
            type="button"
            className="icon-button"
            data-action="prev"
            aria-label="Предыдущий период"
            onClick={() => setPeriod(shiftPeriod(period, -1))}
          >
            <Icon name="left" />
          </button>
        )}
        <button
          type="button"
          className="period-label"
          data-action="period"
          aria-label="Выбрать период"
          onClick={() => open()}
        >
          {periodLabel(period)}
        </button>
        {period.mode !== "all" && (
          <button
            type="button"
            className="icon-button"
            data-action="next"
            aria-label="Следующий период"
            onClick={() => setPeriod(shiftPeriod(period, 1))}
          >
            <Icon name="right" />
          </button>
        )}
      </div>
      {draft && (
        <Dialog title="Выбор периода" onClose={() => !busy && setDraft(null)}>
          <form onSubmit={apply}>
            <label htmlFor="period-mode">Период</label>
            <select
              id="period-mode"
              name="mode"
              value={draft.mode}
              onChange={change}
            >
              {[
                ["day", "День"],
                ["week", "Неделя"],
                ["month", "Месяц"],
                ["year", "Год"],
                ["range", "Период"],
                ["all", "Всё время"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <div
              id="period-anchor"
              hidden={["range", "all"].includes(draft.mode)}
            >
              <label htmlFor="period-date">Дата</label>
              <input
                id="period-date"
                name="anchor"
                type="date"
                value={draft.anchor}
                onChange={change}
              />
            </div>
            <div
              id="period-range"
              className="form-grid"
              hidden={draft.mode !== "range"}
            >
              <div>
                <label htmlFor="period-from">С</label>
                <input
                  id="period-from"
                  name="from"
                  type="date"
                  value={draft.from || today()}
                  onChange={change}
                />
              </div>
              <div>
                <label htmlFor="period-to">По</label>
                <input
                  id="period-to"
                  name="to"
                  type="date"
                  value={draft.to || today()}
                  onChange={change}
                />
              </div>
            </div>
            <p className="small spaced" id="period-preview">
              {preview}
            </p>
            <p className="small spaced">
              Экспорт: все типы операций ·{" "}
              {filters.account
                ? current.state.accounts.find(
                    (account) => account.id === filters.account,
                  )?.name || "Счет"
                : "все счета"}
            </p>
            <p className="form-error" role="alert">
              {error}
            </p>
            <div className="form-actions">
              <button className="primary" type="submit" disabled={busy}>
                Применить
              </button>
              <button
                type="button"
                className="secondary"
                data-action="period-export"
                disabled={busy}
                onClick={(event) => apply(event, true)}
              >
                Выгрузить XLSX
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
