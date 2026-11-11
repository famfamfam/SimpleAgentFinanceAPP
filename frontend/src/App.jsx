import { t } from "/i18n.js";
import { useEffect, useState } from "react";
import { currencyCode } from "/model.js";
import { useFinance } from "./FinanceProvider.jsx";
import { Icon } from "./components/ui.jsx";
import Overview from "./screens/Overview.jsx";
import Entries from "./screens/Entries.jsx";
import Assistant from "./screens/Assistant.jsx";
import Settings from "./screens/Settings.jsx";
import EntryForm from "./features/entries/EntryForm.jsx";
import { useRuntime } from "./services/runtime.js";

const tabs = [
  ["overview", "Обзор", "overview"],
  ["entries", "Операции", "list"],
  ["assistant", "Помощник", "spark"],
  ["settings", "Настройки", "settings"],
];
const route = () =>
  tabs.some(([id]) => id === location.hash.slice(1))
    ? location.hash.slice(1)
    : "overview";
export default function App() {
  const { current, filters, setFilters } = useFinance();
  const [view, setView] = useState(route),
    [entry, setEntry] = useState(null);
  const updateReady = useRuntime();
  useEffect(() => {
    const changed = () => {
        setView(route());
        window.scrollTo(0, 0);
      },
      open = (e) => setEntry(e.detail || {});
    window.addEventListener("hashchange", changed);
    window.addEventListener("finance-entry", open);
    return () => {
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("finance-entry", open);
    };
  }, []);
  const offline = !navigator.onLine,
    issues = current.pending.filter((x) => x.status !== "pending");
  const status = current.settings.revoked
    ? t("Доступ отозван")
    : current.settings.authRequired
      ? t("Нужен вход")
      : !current.settings.connected
        ? t("Локальный учет")
        : offline
          ? t("Без сети")
          : current.pending.length
            ? t("{count} в очереди", { count: current.pending.length })
            : t("Сохранено");
  const sync = (
    <button
      className="icon-button"
      aria-label={t("Синхронизировать")}
      onClick={() => window.dispatchEvent(new Event("finance-sync"))}
    >
      <Icon name="sync" />
    </button>
  );
  const dot = (
    <span className="status" aria-label={status} title={status}>
      <i
        className={`dot ${offline || current.pending.length ? "offline" : ""}`}
      />
      {view === "assistant" || view === "settings" ? status : null}
    </span>
  );
  const settings = (action) =>
    window.dispatchEvent(
      new CustomEvent("finance-settings", { detail: action }),
    );
  return (
    <>
      <div className="shell">
        {view === "overview" ? (
          <header className="topbar overview-header">
            <img
              className="app-icon"
              src="/icon.svg"
              width="32"
              height="32"
              alt={t("Финансы")}
            />
            <div className="overview-account">
              <Icon name="wallet" />
              <select
                id="overview-account"
                aria-label={t("Счет обзора")}
                value={filters.account}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, account: e.target.value }))
                }
              >
                <option value="">{t("Итого")}</option>
                {current.state.accounts
                  .filter((a) => !a.deleted)
                  .map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                      {currencyCode(a.currency) !== "RUB"
                        ? ` · ${currencyCode(a.currency)}`
                        : ""}
                    </option>
                  ))}
              </select>
            </div>
            <div className="row">
              {dot}
              {sync}
            </div>
          </header>
        ) : view === "entries" ? (
          <header className="topbar entries-header">
            <h1>{t("Операции")}</h1>
            <div className="row">
              {dot}
              {sync}
              {!current.settings.revoked && (
                <button
                  className="icon-button entry-add"
                  aria-label={t("Добавить")}
                  onClick={() => setEntry({})}
                >
                  <Icon name="plus" />
                </button>
              )}
            </div>
          </header>
        ) : (
          <header className="topbar">
            <div className="brand">
              <img
                className="app-icon"
                src="/icon.svg"
                width="36"
                height="36"
                alt=""
              />
              <span>{t("Финансы")}</span>
            </div>
            <div className="row">
              {dot}
              {sync}
            </div>
          </header>
        )}
        <aside id="app-update" className="update-banner" hidden={!updateReady}>
          <span>{t("Новая версия готова")}</span>
          <button
            className="secondary"
            onClick={() =>
              window.dispatchEvent(new Event("finance-apply-update"))
            }
          >
            {t("Обновить")}
          </button>
        </aside>
        {current.settings.revoked && (
          <div className="error-banner">
            {t(
              "Доступ к общей книге отозван. Локальная копия закрыта. Скачайте свою резервную копию и выйдите в настройках.",
            )}
          </div>
        )}
        {current.settings.authRequired && (
          <div className="error-banner">
            {t("Сессия завершена. Записи на устройстве сохранены.")}{" "}
            <button className="text-button" onClick={() => settings("recover")}>
              {t("Войти по ключу")}
            </button>
          </div>
        )}
        {!!issues.length && (
          <div className="error-banner">
            {t("{count} изменений требуют внимания.", { count: issues.length })}{" "}
            <button
              className="text-button"
              onClick={() => settings("conflicts")}
            >
              {t("Разобрать")}
            </button>
          </div>
        )}
        {(!current.settings.revoked || view === "settings") && (
          <>
            {view === "overview" && <Overview onEntry={setEntry} />}{" "}
            {view === "entries" && <Entries onEntry={setEntry} />}{" "}
            {view === "assistant" && (
              <Assistant
                key={`${current.settings.userId}:${current.settings.bookId}`}
                onEntry={setEntry}
              />
            )}
          </>
        )}
        <Settings visible={view === "settings"} />
      </div>
      <nav className="nav" aria-label={t("Основная навигация")}>
        {tabs.map(([id, label, icon]) => (
          <a
            key={id}
            href={`#${id}`}
            className={view === id ? "active" : ""}
            aria-current={view === id ? "page" : undefined}
          >
            <Icon name={icon} />
            {t(label)}
          </a>
        ))}
      </nav>
      {entry && <EntryForm entry={entry} onClose={() => setEntry(null)} />}
    </>
  );
}
