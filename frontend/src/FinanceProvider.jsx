import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import * as db from "/db.js";
import { periodEntries, periodRange } from "/model.js";
import {
  getLanguage,
  subscribeLanguage,
  t,
  translateFileError,
} from "/i18n.js";

const FinanceContext = createContext(null);
export const useFinance = () => useContext(FinanceContext);
export function FinanceProvider({ children }) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === "en" ? "Finance" : "Финансы";
  }, [language]);
  const [current, setCurrent] = useState(null);
  const latest = useRef(null);
  const [period, setPeriod] = useState(() => periodRange("month"));
  const [filters, setFilters] = useState({
    account: "",
    kind: "",
    category: "",
    query: "",
  });
  const [highlighted, setHighlighted] = useState(new Set());
  const [notice, setNotice] = useState(null);
  const [toastHost, setToastHost] = useState(document.body);
  const timeout = useRef(null);
  const highlightTimeout = useRef(null);
  const refreshing = useRef(null),
    again = useRef(false),
    mounted = useRef(true);
  const refresh = useCallback(() => {
    again.current = true;
    if (!refreshing.current)
      refreshing.current = (async () => {
        do {
          again.current = false;
          const snapshot = await db.load();
          const settings = await db.meta("settings");
          if (
            settings.bookId !== snapshot.settings.bookId ||
            settings.userId !== snapshot.settings.userId
          ) {
            again.current = true;
            continue;
          }
          if (mounted.current) {
            if (
              latest.current &&
              (latest.current.settings.bookId !== snapshot.settings.bookId ||
                latest.current.settings.userId !== snapshot.settings.userId)
            )
              setFilters({ account: "", kind: "", category: "", query: "" });
            latest.current = snapshot;
            setCurrent(snapshot);
          }
        } while (again.current && mounted.current);
      })().finally(() => {
        refreshing.current = null;
      });
    return refreshing.current;
  }, []);
  const toast = useCallback((message, action) => {
    setToastHost(
      [...document.querySelectorAll("dialog[open]")].at(-1) || document.body,
    );
    setNotice({ message, action });
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setNotice(null), 5000);
  }, []);
  const fail = useCallback(
    (error) => toast(error?.message || String(error)),
    [toast],
  );
  const revealEntries = useCallback(
    async (ids, bookId, background = false) => {
      await refresh();
      const snapshot = latest.current;
      if (snapshot?.settings.bookId !== bookId) return;
      const added = snapshot.state.entries.filter(
        (e) => ids.includes(e.id) && !e.deleted,
      );
      if (!added.length) return;
      const show = () => {
        const dates = added.map((e) => e.date).sort();
        setPeriod((previous) =>
          added.every((e) => periodEntries([e], previous).length)
            ? previous
            : periodRange("range", dates[0], dates[0], dates.at(-1)),
        );
        setFilters({ account: "", kind: "", category: "", query: "" });
        setHighlighted(new Set(ids));
        location.hash = "entries";
        clearTimeout(highlightTimeout.current);
        highlightTimeout.current = setTimeout(
          () => setHighlighted(new Set()),
          6000,
        );
        requestAnimationFrame(() =>
          document
            .querySelector(".entry.just-added")
            ?.scrollIntoView({ block: "center" }),
        );
      };
      if (typeof background === "function" ? background() : background)
        toast(t("Добавлено операций: {count}", { count: ids.length }), {
          label: "Показать",
          run: show,
        });
      else show();
    },
    [refresh, toast],
  );
  useEffect(() => {
    mounted.current = true;
    const update = () => refresh().catch(fail);
    const error = (event) => {
      if ([401, 403].includes(event.detail?.status)) update();
      if (event.detail?.show || [401, 403, 410].includes(event.detail?.status))
        fail(event.detail);
    };
    const host = () =>
      setToastHost(
        [...document.querySelectorAll("dialog[open]")].at(-1) || document.body,
      );
    const events = {
      "finance-updated": update,
      "finance-error": error,
      online: update,
      offline: update,
      "finance-dialog-change": host,
    };
    for (const [name, fn] of Object.entries(events))
      window.addEventListener(name, fn);
    update();
    return () => {
      mounted.current = false;
      for (const [name, fn] of Object.entries(events))
        window.removeEventListener(name, fn);
      clearTimeout(timeout.current);
      clearTimeout(highlightTimeout.current);
    };
  }, [refresh, fail]);
  useEffect(() => {
    if (!current || window.__financeReady) return;
    const frame = requestAnimationFrame(() => {
      window.__financeReady = {
        entries: current.state.entries.filter((e) => !e.deleted).length,
        ms: performance.now(),
      };
    });
    return () => cancelAnimationFrame(frame);
  }, [current]);
  return (
    <FinanceContext.Provider
      value={{
        current,
        language,
        refresh,
        toast,
        fail,
        period,
        setPeriod,
        filters,
        setFilters,
        highlighted,
        revealEntries,
      }}
    >
      {current ? (
        children
      ) : (
        <main className="boot" role="status">
          {t("Открываем ваши записи…")}
        </main>
      )}
      {createPortal(
        <div
          id="toast"
          className={notice ? "show" : ""}
          role="status"
          aria-live="polite"
        >
          {notice?.message ? translateFileError(notice.message) : null}
          {notice?.action && (
            <>
              {" "}
              <button className="text-button" onClick={notice.action.run}>
                {t(notice.action.label)}
              </button>
            </>
          )}
        </div>,
        toastHost,
      )}
    </FinanceContext.Provider>
  );
}
