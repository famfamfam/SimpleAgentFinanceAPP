import { useEffect, useState } from "react";
import {
  cents,
  currencyCode,
  formatMoney,
  dayLabel,
  periodEntries,
} from "/model.js";
import { useFinance } from "../FinanceProvider.jsx";
import { ColoredIcon, Dialog, Icon } from "../components/ui.jsx";
import Period from "../components/Period.jsx";

const kinds = { expense: "Расходы", income: "Доходы", transfer: "Переводы" };

function EntryFilters({ onClose }) {
  const { current, filters, setFilters } = useFinance();
  const [draft, setDraft] = useState({ ...filters });
  const categories = current.state.categories.filter(
    (item) =>
      (!item.deleted || item.id === filters.category) &&
      (!draft.kind || item.kind === draft.kind),
  );
  const changeKind = (kind) =>
    setDraft((previous) => ({
      ...previous,
      kind,
      category:
        categories.find(
          (item) =>
            item.id === previous.category && (!kind || item.kind === kind),
        )?.id || "",
    }));
  return (
    <Dialog title="Фильтры" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFilters(draft);
          onClose();
        }}
      >
        <label htmlFor="filter-account">Счет</label>
        <select
          id="filter-account"
          name="accountId"
          value={draft.account}
          onChange={(event) =>
            setDraft({ ...draft, account: event.target.value })
          }
        >
          <option value="">Все счета</option>
          {current.state.accounts
            .filter((item) => !item.deleted || item.id === filters.account)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
        <label htmlFor="filter-kind">Тип операции</label>
        <select
          id="filter-kind"
          name="kind"
          value={draft.kind}
          onChange={(event) => changeKind(event.target.value)}
        >
          <option value="">Все операции</option>
          {Object.entries(kinds).map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
        <label htmlFor="filter-category">Категория</label>
        <select
          id="filter-category"
          name="categoryId"
          value={draft.category}
          disabled={draft.kind === "transfer"}
          onChange={(event) =>
            setDraft({ ...draft, category: event.target.value })
          }
        >
          <option value="">Все категории</option>
          {categories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <div className="form-actions">
          <button type="submit" className="primary">
            Применить
          </button>
          <button
            type="button"
            className="secondary"
            data-action="clear-entry-filters"
            onClick={() => {
              setFilters({ account: "", kind: "", category: "", query: "" });
              onClose();
            }}
          >
            Сбросить фильтры
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export default function Entries({ onEntry }) {
  const { current, period, filters, setFilters, highlighted } = useFinance();
  const [pageIndex, setPageIndex] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const category = (id) =>
    current.state.categories.find((item) => item.id === id);
  const accountName = (id) =>
    current.state.accounts.find((item) => item.id === id)?.name || "Счет";
  const entries = periodEntries(current.state.entries, period, filters.account)
    .filter(
      (entry) =>
        (!filters.kind || entry.kind === filters.kind) &&
        (!filters.category || entry.categoryId === filters.category) &&
        (!filters.query ||
          `${entry.note} ${entry.tags} ${category(entry.categoryId)?.name || ""}`
            .toLocaleLowerCase()
            .includes(filters.query.toLocaleLowerCase())),
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        (b.time || "").localeCompare(a.time || "") ||
        b.id.localeCompare(a.id),
    );
  const pages = Math.ceil(entries.length / 100);
  const page = Math.min(pageIndex, Math.max(0, pages - 1));
  const count = [filters.account, filters.kind, filters.category].filter(
    Boolean,
  ).length;
  const totals = {};
  for (const entry of entries) {
    if (entry.kind === "transfer") continue;
    const code = currencyCode(entry.currency);
    totals[code] = (totals[code] || 0) + cents(entry.amount);
  }
  const totalsText = Object.entries(totals)
    .map(([code, total]) => formatMoney(total, code))
    .join(" · ");
  useEffect(() => {
    setPageIndex(0);
  }, [period, filters]);
  useEffect(() => {
    if (!highlighted?.size) return;
    const selected = entries.findIndex((entry) => highlighted.has(entry.id));
    if (selected >= 0) setPageIndex(Math.floor(selected / 100));
  }, [highlighted, current, period, filters]);
  useEffect(() => {
    if (highlighted?.size)
      document
        .querySelector(".entry.just-added")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [page, highlighted, current]);
  const clear = (key) => setFilters((previous) => ({ ...previous, [key]: "" }));
  let day = "";
  return (
    <div className="entries-view">
      <Period />
      <div className="entries-tools">
        <div className="entries-search">
          <Icon name="search" />
          <input
            id="search"
            type="search"
            placeholder="Поиск"
            value={filters.query}
            aria-label="Поиск операций"
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                query: event.target.value,
              }))
            }
          />
        </div>
        <button
          type="button"
          className="secondary entries-filter-button"
          data-action="entry-filters"
          aria-label="Фильтры"
          aria-haspopup="dialog"
          onClick={() => setFilterOpen(true)}
        >
          <Icon name="filter" />
          Фильтры{count > 0 && <span className="filter-count">{count}</span>}
        </button>
      </div>
      {count > 0 && (
        <div
          className="entries-active-filters"
          role="group"
          aria-label="Активные фильтры"
        >
          {filters.account && (
            <button
              type="button"
              className="pill"
              data-action="account-filter"
              data-id=""
              aria-label="Сбросить счет"
              onClick={() => clear("account")}
            >
              <span>{accountName(filters.account)}</span>
              <Icon name="close" />
            </button>
          )}
          {filters.kind && (
            <button
              type="button"
              className="pill"
              data-action="clear-kind"
              aria-label="Сбросить тип операции"
              onClick={() => clear("kind")}
            >
              <span>{kinds[filters.kind]}</span>
              <Icon name="close" />
            </button>
          )}
          {filters.category && (
            <button
              type="button"
              className="pill"
              data-action="clear-category"
              aria-label="Сбросить категорию"
              onClick={() => clear("category")}
            >
              <span>{category(filters.category)?.name || "Категория"}</span>
              <Icon name="close" />
            </button>
          )}
        </div>
      )}
      <p className="list-total" id="list-total">
        Записей: {entries.length}
        {totalsText ? <> · {totalsText}</> : null}
      </p>
      <section id="entries-list">
        {entries.slice(page * 100, (page + 1) * 100).map((entry) => {
          const header = entry.date !== day;
          day = entry.date;
          const cat = category(entry.categoryId);
          return (
            <div key={entry.id}>
              {header && <p className="day-heading">{dayLabel(entry.date)}</p>}
              <button
                type="button"
                className={`entry${highlighted?.has(entry.id) ? " just-added" : ""}`}
                data-action="edit-entry"
                data-id={entry.id}
                onClick={() => onEntry(entry)}
              >
                <ColoredIcon
                  category={cat}
                  fallback={entry.kind === "transfer" ? "transfer" : undefined}
                />
                <span className="grow">
                  <span className="entry-name">
                    {entry.kind === "transfer"
                      ? `${accountName(entry.accountId)} → ${accountName(entry.toAccountId)}`
                      : cat?.name || "Без категории"}
                  </span>
                  <span className="entry-sub">
                    {entry.time && (
                      <>
                        <time dateTime={`${entry.date}T${entry.time}`}>
                          {entry.time}
                        </time>{" "}
                        ·{" "}
                      </>
                    )}
                    {entry.note || accountName(entry.accountId)}
                    {entry.author && entry.author !== "local"
                      ? " · " +
                        (current.settings.members?.find(
                          (member) => member.id === entry.author,
                        )?.nickname || "Участник")
                      : ""}
                  </span>
                </span>
                <span>
                  <span className={`entry-sum ${entry.kind}`}>
                    {entry.kind === "income"
                      ? "+"
                      : entry.kind === "expense"
                        ? "−"
                        : ""}
                    {formatMoney(
                      cents(entry.amount),
                      currencyCode(entry.currency),
                    )}
                    {entry.kind === "transfer" &&
                    entry.toCurrency &&
                    currencyCode(entry.currency) !==
                      currencyCode(entry.toCurrency)
                      ? ` → ${formatMoney(cents(entry.toAmount), currencyCode(entry.toCurrency))}`
                      : ""}
                  </span>
                  {entry._pending && (
                    <span className="pending">
                      {entry._issue ? "Требует внимания" : "Ожидает отправки"}
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
        {!entries.length && (
          <div className="empty">
            <div className="category-icon">
              <Icon name="wallet" />
            </div>
            {current.state.entries.some((entry) => !entry.deleted) ||
            filters.query ||
            count ? (
              <>
                <h3>Операций не найдено</h3>
                <p>Измените период или условия поиска.</p>
              </>
            ) : (
              <>
                <h3>Пока нет операций</h3>
                <p>
                  Добавьте первый расход или доход.
                  <br />
                  Запись сохранится, даже если нет сети.
                </p>
              </>
            )}
          </div>
        )}
        {pages > 1 && (
          <div className="pagination">
            <button
              type="button"
              className="secondary"
              data-action="page-prev"
              disabled={page === 0}
              onClick={() => setPageIndex(page - 1)}
            >
              Назад
            </button>
            <span>
              {page + 1} / {pages}
            </span>
            <button
              type="button"
              className="secondary"
              data-action="page-next"
              disabled={page + 1 >= pages}
              onClick={() => setPageIndex(page + 1)}
            >
              Дальше
            </button>
          </div>
        )}
      </section>
      {filterOpen && <EntryFilters onClose={() => setFilterOpen(false)} />}
    </div>
  );
}
