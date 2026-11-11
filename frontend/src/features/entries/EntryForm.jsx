import { t } from "/i18n.js";
import { useEffect, useRef, useState } from "react";
import * as db from "/db.js";
import { sync } from "/sync.js";
import {
  cents,
  decimal,
  currencyCode,
  formatMoney,
  today,
  clock,
  validateEntry,
} from "/model.js";
import { useFinance } from "../../FinanceProvider.jsx";
import { Dialog, Icon, ColoredIcon } from "../../components/ui.jsx";
import { CatalogForm } from "../catalog/Catalog.jsx";
import { readDraft, writeDraft } from "../../services/draft.js";
import { draftValue, putDraft } from "/chat-db.js";

export default function EntryForm({ entry = {}, onClose }) {
  const { current, refresh, toast, revealEntries, filters } = useFinance();
  const restored = entry?.draft ? entry : null;
  const existing = !!entry?.id && !restored;
  const scope = useRef({
    bookId: current.settings.bookId,
    userId: current.settings.userId,
  });
  const latest = useRef(current);
  latest.current = current;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [draft, setDraft] = useState(() =>
    restored
      ? { ...restored.draft }
      : existing
        ? { ...entry }
        : {
            id: crypto.randomUUID(),
            kind: "expense",
            amount: "",
            accountId:
              current.state.accounts.find(
                (a) => !a.deleted && a.id === filters.account,
              )?.id ||
              current.state.accounts.find((a) => !a.deleted)?.id ||
              "",
            categoryId: "",
            toAccountId: "",
            date: today(),
            time: clock(),
            note: "",
            tags: "",
            version: 0,
            deleted: false,
            author: current.settings.userId || "local",
            editor: current.settings.userId || "local",
          },
  );
  const [expanded, setExpanded] = useState(!!restored?.expanded);
  const [accountExpanded, setAccountExpanded] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(
    !!(
      entry.note ||
      entry.tags ||
      restored?.draft.note ||
      restored?.draft.tags
    ),
  );
  const [nested, setNested] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key, value) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const guard = async () => {
    const settings = await db.meta("settings");
    if (
      !alive.current ||
      latest.current.settings.bookId !== scope.current.bookId ||
      latest.current.settings.userId !== scope.current.userId ||
      settings.bookId !== scope.current.bookId ||
      settings.userId !== scope.current.userId
    )
      throw Error(
        "Книга или пользователь изменились. Откройте операцию заново",
      );
  };
  const background = () => {
    if (
      latest.current.settings.connected &&
      !latest.current.settings.revoked &&
      navigator.onLine
    )
      sync()
        .then(refresh)
        .catch(() => {});
  };
  const clearDraft = async () => {
    await db.transaction(["meta"], async (tx) => {
      const store = tx.objectStore("meta");
      const settings = (await db.request(store.get("settings")))?.value;
      if (
        settings?.bookId !== scope.current.bookId ||
        settings?.userId !== scope.current.userId
      )
        return;
      const saved = await draftValue(store, scope.current, "entry");
      if (saved?.draft?.id === draft.id)
        await putDraft(store, scope.current, "entry", null);
    });
  };
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await guard();
      const source = latest.current.state.accounts.find(
        (a) => a.id === draft.accountId,
      );
      const target = latest.current.state.accounts.find(
        (a) => a.id === draft.toAccountId,
      );
      const currency = currencyCode(source?.currency);
      const toCurrency = currencyCode(target?.currency);
      const isTransfer = draft.kind === "transfer";
      const item = {
        ...draft,
        amount: decimal(cents(draft.amount)),
        currency,
        categoryId: isTransfer ? "" : draft.categoryId,
        toAccountId: isTransfer ? draft.toAccountId : "",
        toCurrency: isTransfer ? toCurrency : undefined,
        toAmount: isTransfer
          ? decimal(
              cents(currency === toCurrency ? draft.amount : draft.toAmount),
            )
          : undefined,
        time: draft.time || "",
        note: draft.note || "",
        tags: draft.tags || "",
      };
      validateEntry(item, latest.current.state);
      await guard();
      await db.save("entry", item, scope.current);
      await clearDraft();
      onClose();
      if (existing) await refresh();
      else await revealEntries([item.id], scope.current.bookId);
      toast(t(existing ? "Изменения сохранены" : "Сохранено на устройстве"));
      background();
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const remove = async () => {
    if (
      busy ||
      !confirm(
        t(
          current.settings.connected
            ? "Удалить операцию? Изменение будет отправлено участникам книги."
            : "Удалить операцию из локального учета?",
        ),
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await guard();
      const original = latest.current.state.entries.find(
        (x) => x.id === draft.id,
      );
      if (!original) throw Error("Операция больше не существует");
      await db.save("entry", { ...original, deleted: true }, scope.current);
      await clearDraft();
      onClose();
      await refresh();
      background();
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const close = async () => {
    if (busy) return;
    if (restored) {
      try {
        await guard();
        await writeDraft(scope.current, { draft, expanded }, "entry");
      } catch (e) {
        setError(e.message);
        return;
      }
    }
    onClose();
  };
  const assistant = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await guard();
      await writeDraft(scope.current, { draft, expanded }, "entry");
      const text = await readDraft(scope.current);
      if (!String(text || "").trim() && (draft.amount || draft.note)) {
        const code = currencyCode(
          latest.current.state.accounts.find((a) => a.id === draft.accountId)
            ?.currency,
        );
        await writeDraft(
          scope.current,
          `${t(draft.kind === "income" ? "Доход" : draft.kind === "transfer" ? "Перевод" : "Расход")} ${draft.amount ? draft.amount + " " + (code === "RUB" ? "₽" : code) : ""} ${draft.note || ""}`
            .trim()
            .slice(0, 4096),
        );
      }
      await guard();
      onClose();
      window.dispatchEvent(new Event("finance-assistant-draft"));
      location.hash = "assistant";
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const accounts = current.state.accounts.filter((a) => !a.deleted);
  const sourceCurrency = currencyCode(
    current.state.accounts.find((a) => a.id === draft.accountId)?.currency,
  );
  const destinationCurrency = currencyCode(
    current.state.accounts.find((a) => a.id === draft.toAccountId)?.currency,
  );
  const setSource = (previous, account) => {
    const oldCurrency = currencyCode(
      current.state.accounts.find((a) => a.id === previous.accountId)?.currency,
    );
    const nextCurrency = currencyCode(account?.currency);
    return {
      ...previous,
      accountId: account?.id || "",
      currency: nextCurrency,
      amount: oldCurrency === nextCurrency ? previous.amount : "",
      toAmount: oldCurrency === nextCurrency ? previous.toAmount : "",
      toAccountId:
        previous.toAccountId === account?.id ? "" : previous.toAccountId,
    };
  };
  const archived =
    existing &&
    (current.state.accounts.some(
      (a) =>
        a.deleted && (a.id === draft.accountId || a.id === draft.toAccountId),
    ) ||
      current.state.categories.some(
        (c) => c.deleted && c.id === draft.categoryId,
      ));
  if (nested)
    return (
      <CatalogForm
        entity={nested === "category" ? "category" : "account"}
        expectedScope={scope.current}
        initialKind={nested === "category" ? draft.kind : undefined}
        onClose={() => setNested("")}
        onSaved={(item) => {
          setDraft((previous) =>
            nested === "category"
              ? { ...previous, categoryId: item.id }
              : nested === "toAccount"
                ? { ...previous, toAccountId: item.id, toAmount: "" }
                : setSource(previous, item),
          );
          setNested("");
        }}
      />
    );
  if (archived)
    return (
      <Dialog title={t("Архивная операция")} onClose={close}>
        <p>
          {draft.date} ·{" "}
          {formatMoney(cents(draft.amount), currencyCode(draft.currency))}
        </p>
        <p className="small spaced">{draft.note}</p>
        <p className="small spaced">
          {t(
            "Счет или категория в архиве. Эта запись доступна для просмотра и удаления.",
          )}
        </p>
        <p className="form-error" role="alert">
          {t(error)}
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="danger"
            data-action="delete-entry"
            disabled={busy}
            onClick={remove}
          >
            {t("Удалить операцию")}
          </button>
        </div>
      </Dialog>
    );
  const cats = current.state.categories.filter(
    (c) => !c.deleted && c.kind === draft.kind,
  );
  const shown = expanded
    ? cats.filter((c) =>
        c.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      )
    : cats.slice(0, 9);
  const selected = cats.find((c) => c.id === draft.categoryId);
  if (!expanded && selected && !shown.includes(selected)) shown[8] = selected;
  const accountFields = (
    <>
      <div className="row between field-heading">
        <label htmlFor="entry-account">
          {t(draft.kind === "transfer" ? "Откуда" : "Счет")}
        </label>
        <button
          type="button"
          data-action="entry-new-account"
          className="text-button"
          onClick={() => setNested("account")}
        >
          <Icon name="plus" />
          {t("Новый счет")}
        </button>
      </div>
      <select
        id="entry-account"
        name="accountId"
        value={draft.accountId || ""}
        onChange={(e) =>
          setDraft((previous) =>
            setSource(
              previous,
              accounts.find((a) => a.id === e.target.value),
            ),
          )
        }
      >
        <option value="">{t("Выберите счет")}</option>
        {accounts.map((a) => (
          <option
            key={a.id}
            value={a.id}
            disabled={
              existing &&
              currencyCode(a.currency) !== currencyCode(entry.currency)
            }
          >
            {a.name}
            {currencyCode(a.currency) !== "RUB"
              ? ` · ${currencyCode(a.currency)}`
              : ""}
          </option>
        ))}
      </select>
    </>
  );
  return (
    <Dialog
      title={t(existing ? "Изменить операцию" : "Новая операция")}
      onClose={close}
    >
      <form id="entry-form" onSubmit={save}>
        <div className="segmented">
          {[
            ["expense", "Расход"],
            ["income", "Доход"],
            ["transfer", "Перевод"],
          ].map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              data-action="entry-kind"
              data-kind={kind}
              className={draft.kind === kind ? "active" : ""}
              aria-pressed={draft.kind === kind}
              onClick={() =>
                setDraft((previous) => ({ ...previous, kind, categoryId: "" }))
              }
            >
              {t(label)}
            </button>
          ))}
        </div>
        <label htmlFor="entry-amount" className="entry-amount-label">
          {t("Сумма, {currency}", {
            currency: sourceCurrency === "RUB" ? "₽" : sourceCurrency,
          })}
        </label>
        <div className="amount-entry">
          <input
            id="entry-amount"
            className="amount-input"
            name="amount"
            inputMode="decimal"
            enterKeyHint="done"
            placeholder="0"
            aria-label={t("Сумма")}
            required
            autoComplete="off"
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
          {!existing && (
            <button
              type="button"
              data-action="entry-assistant"
              className="amount-assistant"
              aria-label={t("Добавить через помощника")}
              title={t("Добавить через помощника: текст, голос или чек")}
              onClick={assistant}
              disabled={busy}
            >
              <Icon name="spark" />
            </button>
          )}
        </div>
        {draft.kind === "transfer" ? (
          <>
            {accountFields}
            <div className="row between field-heading">
              <label htmlFor="entry-to">{t("Куда")}</label>
              <button
                type="button"
                data-action="entry-new-to-account"
                className="text-button"
                onClick={() => setNested("toAccount")}
              >
                <Icon name="plus" />
                {t("Новый счет получателя")}
              </button>
            </div>
            <select
              id="entry-to"
              name="toAccountId"
              value={draft.toAccountId || ""}
              onChange={(e) =>
                setDraft((previous) => ({
                  ...previous,
                  toAccountId: e.target.value,
                  toAmount: "",
                }))
              }
            >
              <option value="">{t("Выберите счет")}</option>
              {accounts
                .filter((a) => a.id !== draft.accountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {currencyCode(a.currency) !== "RUB"
                      ? ` · ${currencyCode(a.currency)}`
                      : ""}
                  </option>
                ))}
            </select>
            {draft.toAccountId && sourceCurrency !== destinationCurrency && (
              <>
                <label htmlFor="entry-to-amount">
                  {t("Получено, {currency}", { currency: destinationCurrency })}
                </label>
                <input
                  id="entry-to-amount"
                  name="toAmount"
                  inputMode="decimal"
                  required
                  autoComplete="off"
                  value={draft.toAmount || ""}
                  onChange={(e) => set("toAmount", e.target.value)}
                />
              </>
            )}
          </>
        ) : (
          <>
            <div className="row between field-heading">
              <label>{t("Категория")}</label>
              <button
                type="button"
                data-action="entry-new-category"
                className="text-button"
                onClick={() => setNested("category")}
              >
                <Icon name="plus" />
                {t("Новая категория")}
              </button>
            </div>
            <input
              type="hidden"
              name="categoryId"
              value={draft.categoryId || ""}
            />
            {expanded && cats.length > 9 && (
              <input
                id="category-search"
                type="search"
                placeholder={t("Найти категорию")}
                aria-label={t("Поиск категории")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              />
            )}
            <div className="categories-grid">
              {shown.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  data-action="choose-category"
                  data-id={c.id}
                  className={`category-choice ${draft.categoryId === c.id ? "selected" : ""}`}
                  aria-pressed={draft.categoryId === c.id}
                  onClick={() => set("categoryId", c.id)}
                >
                  <ColoredIcon category={c} />
                  {c.name}
                </button>
              ))}
            </div>
            {!shown.length && (
              <p className="small" id="category-empty">
                {t("Категория не найдена. Можно создать новую.")}
              </p>
            )}
            {cats.length > 9 && (
              <button
                type="button"
                data-action="entry-more-categories"
                className="secondary full"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded
                  ? t("Свернуть категории")
                  : t("Все категории ({count})", { count: cats.length })}
              </button>
            )}
          </>
        )}
        <div className="form-grid">
          <div>
            <label htmlFor="entry-date">{t("Дата")}</label>
            <input
              id="entry-date"
              name="date"
              type="date"
              value={draft.date}
              required
              onChange={(e) => set("date", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="entry-time">{t("Время")}</label>
            <input
              id="entry-time"
              name="time"
              type="time"
              step="60"
              value={draft.time || ""}
              onChange={(e) => set("time", e.target.value)}
            />
          </div>
        </div>
        <div className="quick-dates">
          {["Сегодня", "Вчера", "Позавчера"].map((label, days) => {
            const date = new Date();
            date.setDate(date.getDate() - days);
            const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            return (
              <button
                key={days}
                type="button"
                data-action="quick-date"
                data-date={value}
                className={`pill ${draft.date === value ? "active" : ""}`}
                onClick={() => set("date", value)}
              >
                {t(label)}
              </button>
            );
          })}
        </div>
        {draft.kind !== "transfer" && (
          <details
            id="entry-account-details"
            open={accountExpanded}
            onToggle={(e) => setAccountExpanded(e.currentTarget.open)}
          >
            <summary>
              {t("Счет")}:{" "}
              <span id="entry-account-name">
                {accounts.find((a) => a.id === draft.accountId)?.name ||
                  t("Выберите счет")}
              </span>
            </summary>
            {accountFields}
          </details>
        )}
        <details
          open={notesExpanded}
          onToggle={(event) => setNotesExpanded(event.currentTarget.open)}
        >
          <summary>{t("Комментарий и теги")}</summary>
          <label htmlFor="entry-note">{t("Комментарий")}</label>
          <textarea
            id="entry-note"
            name="note"
            maxLength="4096"
            value={draft.note || ""}
            onChange={(e) => set("note", e.target.value)}
          />
          <label htmlFor="entry-tags">{t("Теги")}</label>
          <input
            id="entry-tags"
            name="tags"
            value={draft.tags || ""}
            maxLength="512"
            onChange={(e) => set("tags", e.target.value)}
          />
        </details>
        <p className="form-error" role="alert">
          {t(error)}
        </p>
        <div className="form-actions">
          {existing && (
            <button
              type="button"
              data-action="delete-entry"
              className="danger"
              aria-label={t("Удалить операцию")}
              disabled={busy}
              onClick={remove}
            >
              <Icon name="trash" />
            </button>
          )}
          <button className="primary" type="submit" disabled={busy}>
            {t("Сохранить")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
