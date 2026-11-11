import { t, getLanguage, setLanguage, translateFileError } from "/i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import * as db from "/db.js";
import * as chat from "/chat-db.js";
import { api, sync } from "/sync.js";
import { APP_VERSION } from "/release.js";
import {
  cents,
  initialState,
  periodRange,
  currencyCode,
  formatMoney,
  today,
} from "/model.js";
import { useFinance } from "../FinanceProvider.jsx";
import { Dialog, Icon } from "../components/ui.jsx";
import { Catalog, CatalogForm } from "../features/catalog/Catalog.jsx";
import {
  applyImport,
  chooseFile,
  download,
  exportFile,
  previewImport,
} from "../services/files.js";

function Form({
  onSubmit,
  children,
  label = t("Сохранить"),
  disabled = false,
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const data = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        try {
          await onSubmit(data);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      <p className="form-error" role="alert">
        {error ? translateFileError(error) : null}
      </p>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || disabled}>
          {label}
        </button>
      </div>
    </form>
  );
}
function RecoveryKey({ value, onDone, fail }) {
  const [qr, setQR] = useState("");
  useEffect(() => {
    let active = true,
      url;
    fetch("/api/qr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: value }),
    })
      .then(async (response) => {
        if (!response.ok) throw Error(t("Не удалось создать QR"));
        return response.blob();
      })
      .then((blob) => {
        if (active) {
          url = URL.createObjectURL(blob);
          setQR(url);
        }
      })
      .catch(fail);
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [value, fail]);
  return (
    <>
      <p className="small">
        {t(
          "Сохраните ключ или QR в надежном месте. Они открывают вашу личность на другом устройстве. Восстановление требует сети.",
        )}
      </p>
      <div className="key-box mono">{value}</div>
      {qr && (
        <img
          className="qr"
          id="recovery-qr"
          src={qr}
          alt={t("QR с личным ключом восстановления")}
        />
      )}
      <div className="stack">
        <button
          className="primary"
          onClick={() => navigator.clipboard.writeText(value).catch(fail)}
        >
          {t("Скопировать ключ")}
        </button>
        <button
          className="secondary"
          onClick={() =>
            download(
              new Blob(["finance-key:v1:" + value], { type: "text/plain" }),
              "finance-recovery.txt",
            )
          }
        >
          {t("Скачать ключ")}
        </button>
        <button className="secondary" data-action="close" onClick={onDone}>
          {t("Я сохранил ключ")}
        </button>
      </div>
    </>
  );
}

export default function Settings({ visible }) {
  const finance = useFinance(),
    { current, refresh, toast, fail, period, filters, setPeriod, setFilters } =
      finance;
  const latest = useRef(current);
  latest.current = current;
  const [modal, setModal] = useState(null),
    [catalog, setCatalog] = useState(null),
    [catalogForm, setCatalogForm] = useState(null),
    [offline, setOffline] = useState(
      "Первичная загрузка: оставьте приложение открытым с сетью.",
    );
  const account = useRef(null),
    importBusy = useRef(false);
  const guard = async (settings) => {
    const s = await db.meta("settings");
    if (s.bookId !== settings.bookId || s.userId !== settings.userId)
      throw Error(t("Книга или пользователь изменились. Откройте окно заново"));
    return s;
  };
  const close = () => {
    const m = modal;
    setModal(null);
    m?.cancel?.();
  };
  const modalSequence = useRef(0);
  const show = (title, content, settings = current.settings, cancel) =>
    setModal({
      id: ++modalSequence.current,
      title,
      content,
      settings: { ...settings },
      cancel,
    });
  const run = (fn) => () => Promise.resolve().then(fn).catch(fail);
  const loadMe = async () => {
    const s = await db.meta("settings");
    const me = await api("/api/me");
    account.current = me;
    if (s.connected && me.user.id !== s.userId) return me;
    const members = s.connected
      ? await api(
          `/api/books/${s.bookId}/members`,
          undefined,
          undefined,
          s.userId,
        )
      : [];
    await guard(s);
    await db.setMeta("settings", {
      ...(await db.meta("settings")),
      members,
      nickname: me.user.nickname,
      authRequired: false,
    });
    await refresh();
    return me;
  };
  const showKey = (key, settings = current.settings) =>
    new Promise((resolve) =>
      show(
        "Ключ восстановления",
        () => (
          <RecoveryKey
            value={key}
            fail={fail}
            onDone={() => {
              setModal(null);
              resolve();
            }}
          />
        ),
        settings,
        resolve,
      ),
    );
  const ensureUser = async () => {
    try {
      const me = await api("/api/me");
      account.current = me;
      return me;
    } catch (e) {
      if (e.status !== 401) throw e;
    }
    const settings = { ...latest.current.settings };
    return new Promise((resolve, reject) =>
      show(
        "Подключение к серверу",
        () => (
          <Form
            label={t("Продолжить")}
            onSubmit={async (data) => {
              await guard(settings);
              const result = await api("/api/register", {
                nickname: data.get("nickname"),
                password: data.get("password"),
              });
              const me = await api("/api/me");
              account.current = me;
              await showKey(result.recoveryKey, settings);
              await guard(settings);
              resolve(me);
            }}
          >
            <p className="small">
              {t(
                "Для регистрации нужен пароль владельца сервера. После регистрации сохраните личный ключ для входа с других устройств.",
              )}
            </p>
            <label htmlFor="nickname">{t("Как вас называть?")}</label>
            <input
              id="nickname"
              name="nickname"
              maxLength={80}
              placeholder={t("Например, Саша")}
              required
            />
            <label htmlFor="registration-password">{t("Пароль доступа")}</label>
            <input
              id="registration-password"
              name="password"
              type="password"
              maxLength={1024}
              autoComplete="current-password"
              required
            />
          </Form>
        ),
        settings,
        () => reject(Error(t("Подключение отменено"))),
      ),
    );
  };
  const connect = async () => {
    const settings = { ...latest.current.settings },
      me = await ensureUser();
    await guard(settings);
    await api(
      "/api/books",
      {
        id: settings.bookId,
        name: settings.bookName,
        language: settings.initialLanguage || "ru",
      },
      undefined,
      me.user.id,
    );
    await guard(settings);
    await db.setMeta("settings", {
      ...settings,
      connected: true,
      userId: me.user.id,
      nickname: me.user.nickname,
    });
    await refresh();
    await sync();
    toast(t("Синхронизация подключена"));
  };
  const recover = () => {
    const settings = { ...current.settings };
    show(
      "Восстановить вход",
      () => (
        <Form
          label={t("Продолжить")}
          onSubmit={async (data) => {
            await guard(settings);
            await api("/api/recover", { key: data.get("key") });
            const me = await api("/api/me");
            account.current = me;
            if (me.books.length) {
              const book =
                me.books.find((x) => x.id === settings.bookId) || me.books[0];
              if (
                book.id === settings.bookId &&
                me.user.id === settings.userId
              ) {
                await db.reconnect(
                  settings.bookId,
                  settings.userId,
                  me.user.nickname,
                );
                await sync().catch(() => {});
              } else {
                const snapshot = await api(
                  `/api/books/${book.id}/sync`,
                  undefined,
                  undefined,
                  me.user.id,
                );
                await db.switchBook(
                  {
                    ...settings,
                    bookId: book.id,
                    bookName: book.name,
                    connected: true,
                    userId: me.user.id,
                    nickname: me.user.nickname,
                    revoked: false,
                    authRequired: false,
                  },
                  snapshot,
                  settings,
                );
              }
            } else {
              await guard(settings);
              await db.setMeta("settings", {
                ...settings,
                connected: false,
                userId: me.user.id,
                nickname: me.user.nickname,
                authRequired: false,
              });
            }
            setModal(null);
            await refresh();
            await loadMe();
            toast(t("Вход восстановлен"));
          }}
        >
          <p className="small">
            {t("Вставьте личный ключ или содержимое QR.")}
          </p>
          <label htmlFor="recovery-key">{t("Ключ восстановления")}</label>
          <textarea
            id="recovery-key"
            name="key"
            required
            autoComplete="off"
            spellCheck={false}
          />
        </Form>
      ),
      settings,
    );
  };
  const join = async () => {
    const settings = { ...current.settings },
      me = await ensureUser();
    await guard(settings);
    show(
      "Присоединиться к книге",
      () => (
        <Form
          label={t("Продолжить")}
          onSubmit={async (data) => {
            await guard(settings);
            if (
              !confirm(
                t(
                  "Переключиться на общую книгу? Текущие локальные данные сохранятся в архиве резервной копии.",
                ),
              )
            )
              return;
            const result = await api(
                "/api/join",
                { code: data.get("code") },
                undefined,
                me.user.id,
              ),
              snapshot = await api(
                `/api/books/${result.bookId}/sync`,
                undefined,
                undefined,
                me.user.id,
              );
            await db.switchBook(
              {
                ...settings,
                bookId: result.bookId,
                bookName: "Общая книга",
                connected: true,
                userId: me.user.id,
                nickname: me.user.nickname,
                revoked: false,
                authRequired: false,
              },
              snapshot,
              settings,
            );
            setModal(null);
            await refresh();
            await loadMe();
          }}
        >
          <p className="small">
            {t(
              "Текущая книга будет сохранена в локальном архиве резервной копии.",
            )}
          </p>
          <label htmlFor="join-code">{t("Одноразовый код")}</label>
          <input
            id="join-code"
            name="code"
            maxLength={8}
            minLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            required
          />
        </Form>
      ),
      settings,
    );
  };
  const members = async () => {
    const settings = { ...current.settings };
    const me = account.current || (await loadMe()),
      items = await api(
        `/api/books/${settings.bookId}/members`,
        undefined,
        undefined,
        settings.userId,
      );
    await guard(settings);
    const owner = items.find((x) => x.owner)?.id;
    show(
      "Участники",
      () => (
        <>
          <p className="small">{settings.bookName}</p>
          {items.map((x) => (
            <div className="setting-row" key={x.id}>
              <span className="grow">{x.nickname}</span>
              <span className="badge">
                {x.owner ? t("Владелец") : t("Участник")}
              </span>
              {me.user.id === owner && !x.owner && (
                <button
                  className="icon-button"
                  aria-label={t("Удалить участника")}
                  onClick={run(async () => {
                    await guard(settings);
                    if (confirm(t("Удалить участника из общей книги?"))) {
                      await api(
                        `/api/books/${settings.bookId}/members/${x.id}`,
                        null,
                        "DELETE",
                        settings.userId,
                      );
                      await members();
                    }
                  })}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
          ))}
          {me.user.id === owner && (
            <button
              className="primary full spaced"
              onClick={run(async () => {
                await guard(settings);
                const invite = await api(
                  `/api/books/${settings.bookId}/invite`,
                  {},
                  undefined,
                  settings.userId,
                );
                show(
                  "Приглашение",
                  () => (
                    <>
                      <p className="small">
                        {t(
                          "Код действует 15 минут и подключает одного участника.",
                        )}
                      </p>
                      <p className="key-box mono">{invite.code}</p>
                      <p className="small">
                        {t(
                          "На втором устройстве: Настройки → Присоединиться по коду.",
                        )}
                      </p>
                    </>
                  ),
                  settings,
                );
              })}
            >
              {t("Пригласить участника")}
            </button>
          )}
        </>
      ),
      settings,
    );
  };
  const integrations = async () => {
    const settings = { ...current.settings },
      list = await api(
        `/api/books/${settings.bookId}/integrations`,
        undefined,
        undefined,
        settings.userId,
      );
    await guard(settings);
    show(
      "MCP-подключения",
      () => (
        <>
          <p className="small">
            {t("Личный токен внешнего агента. Храните его как пароль.")}
          </p>
          {list.map((x) => (
            <div className="setting-row" key={x.id}>
              <span className="grow">{x.name}</span>
              <button
                className="text-button"
                onClick={run(async () => {
                  await guard(settings);
                  await api(
                    `/api/books/${settings.bookId}/integrations/${x.id}`,
                    null,
                    "DELETE",
                    settings.userId,
                  );
                  await integrations();
                })}
              >
                {t("Отозвать")}
              </button>
            </div>
          ))}
          <Form
            label={t("Создать токен")}
            onSubmit={async (data) => {
              await guard(settings);
              const result = await api(
                `/api/books/${settings.bookId}/integrations`,
                { name: data.get("name"), write: data.get("write") === "on" },
                undefined,
                settings.userId,
              );
              await guard(settings);
              show(
                "Токен MCP",
                () => (
                  <>
                    <p className="small">
                      {t(
                        "Показывается один раз. Передавайте как заголовок Authorization: Bearer TOKEN.",
                      )}
                    </p>
                    <p className="key-box mono">{result.token}</p>
                  </>
                ),
                settings,
              );
            }}
          >
            <label htmlFor="integration-name">{t("Название")}</label>
            <input id="integration-name" name="name" maxLength={80} required />
            <label className="check">
              <input name="write" type="checkbox" />
              {t("Разрешить изменение записей")}
            </label>
          </Form>
        </>
      ),
      settings,
    );
  };
  const sessions = async () => {
    const settings = { ...current.settings },
      items = await api("/api/sessions");
    await guard(settings);
    show(
      "Устройства",
      () => (
        <>
          {items.map((s) => (
            <div className="setting-row" key={s.id}>
              <span className="grow">
                {s.current ? t("Это устройство") : t("Другая сессия")}
                <p className="small">
                  {new Date(s.createdAt).toLocaleDateString(
                    getLanguage() === "en" ? "en-GB" : "ru-RU",
                  )}
                </p>
              </span>
              {!s.current && (
                <button
                  className="text-button"
                  onClick={run(async () => {
                    await guard(settings);
                    await api(
                      "/api/sessions/" + s.id,
                      null,
                      "DELETE",
                      settings.userId,
                    );
                    await sessions();
                  })}
                >
                  {t("Отозвать")}
                </button>
              )}
            </div>
          ))}
        </>
      ),
      settings,
    );
  };
  const conflicts = () => {
    const settings = { ...current.settings },
      problems = current.pending.filter((x) => x.status !== "pending");
    show(
      "Изменения требуют внимания",
      () =>
        problems.length ? (
          <>
            {problems.map((c) => (
              <section className="spaced" key={c.id}>
                <h3>
                  {c.data.note ||
                    c.data.name ||
                    t("Операция {amount}", { amount: c.data.amount || "" })}
                </h3>
                <p className="small spaced">
                  {c.error
                    ? t(c.error)
                    : t(
                        "Запись изменена другим участником. Ваша версия сохранена на устройстве.",
                      )}
                </p>
                <div className="row spaced">
                  {[
                    [true, "Отправить мою версию"],
                    [false, "Принять серверную"],
                  ].map(([local, label]) => (
                    <button
                      key={label}
                      className={local ? "primary" : "secondary"}
                      onClick={run(async () => {
                        await guard(settings);
                        await db.resolveConflict(
                          c.entity,
                          c.data.id,
                          local,
                          settings,
                        );
                        setModal(null);
                        await refresh();
                        sync().catch(fail);
                      })}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </>
        ) : (
          <p>{t("Конфликтов нет")}</p>
        ),
      settings,
    );
  };
  const showImported = async (preview) => {
    await guard(preview.local.settings);
    if (preview.connected) {
      const snapshot = await api(
        `/api/books/${preview.bookId}/sync`,
        undefined,
        undefined,
        preview.local.settings.userId,
      );
      await guard(preview.local.settings);
      await db.accept(snapshot, preview.bookId);
    }
    await guard(preview.local.settings);
    setPeriod(periodRange("all"));
    setFilters({ account: "", kind: "", category: "", query: "" });
    await refresh();
    location.hash = "entries";
  };
  const importFile = async (file) => {
    if (importBusy.current) throw Error(t("Другой файл еще обрабатывается"));
    importBusy.current = true;
    try {
      if (current.settings.connected) await sync({ wait: true });
      toast(t("Читаем XLSX…"));
      const preview = await previewImport(file);
      if (preview.already) {
        await showImported(preview);
        toast(t("Этот файл уже импортирован"));
        return;
      }
      const { proposal, catalogs } = preview;
      const label = (e) =>
        e.kind === "transfer"
          ? catalogs.accounts.find((x) => x.id === e.accountId)?.name +
            " → " +
            catalogs.accounts.find((x) => x.id === e.toAccountId)?.name
          : catalogs.categories.find((x) => x.id === e.categoryId)?.name ||
            t("Категория");
      show(
        "Проверка импорта",
        () => (
          <Form
            label={t("Импортировать")}
            disabled={!!proposal.errors.length}
            onSubmit={async (data) => {
              const result = await applyImport(
                preview,
                data.getAll("duplicates"),
              );
              setModal(null);
              await showImported(preview);
              sync().catch(fail);
              toast(
                result.alreadyApplied
                  ? t("Файл уже импортирован")
                  : t("Добавлено: {count}", { count: result.imported }),
              );
            }}
          >
            <p>
              {t("Операций: {count} · возможных дублей: {duplicates}", {
                count: proposal.entries.length,
                duplicates: proposal.duplicates.length,
              })}
            </p>
            {proposal.errors.map((e, i) => (
              <p className="form-error" key={i}>
                {translateFileError(e)}
              </p>
            ))}
            <div className="import-preview">
              {proposal.entries.map((e) => (
                <div className="import-row" key={e.id}>
                  <span>
                    {e.date} · {label(e)} · {e.note}
                  </span>
                  <strong>
                    {formatMoney(cents(e.amount), currencyCode(e.currency))}
                    {e.kind === "transfer" &&
                    e.toCurrency &&
                    currencyCode(e.currency) !== currencyCode(e.toCurrency)
                      ? ` → ${formatMoney(cents(e.toAmount), currencyCode(e.toCurrency))}`
                      : ""}
                  </strong>
                  {proposal.duplicates.includes(e.id) && (
                    <label className="check">
                      <input type="checkbox" name="duplicates" value={e.id} />
                      {t("Возможный повтор — добавить строку ещё раз")}
                    </label>
                  )}
                </div>
              ))}
            </div>
          </Form>
        ),
        preview.local.settings,
      );
    } finally {
      importBusy.current = false;
    }
  };
  const archives = async () => {
    const items = (await db.backup()).meta.filter((x) =>
      x.id.startsWith("archive:"),
    );
    show("Локальные архивы", () =>
      items.length ? (
        <>
          {items.map((x) => (
            <div className="setting-row" key={x.id}>
              <span className="grow">
                {x.value.settings?.bookName || t("Книга")}
              </span>
              <button
                className="text-button"
                onClick={run(async () => {
                  const archive = await db.meta(x.id);
                  download(
                    db.backupFile({
                      format: "finance-backup-v4",
                      origin: location.origin,
                      base: archive.base,
                      outbox: archive.pending,
                      meta: [{ id: "settings", value: archive.settings }],
                      messages: [],
                      media: [],
                    }),
                    "finance-archive.json",
                  );
                })}
              >
                {t("Скачать копию")}
              </button>
            </div>
          ))}
        </>
      ) : (
        <p className="small">
          {t("Архивов пока нет. Они создаются при переключении книги.")}
        </p>
      ),
    );
  };
  const diagnostics = async () => {
    const estimate = await navigator.storage?.estimate?.(),
      persistent = await navigator.storage?.persisted?.(),
      permission =
        persistent === false ? await db.meta("storage-permission") : null,
      media = await chat.mediaStats(),
      size = (n) =>
        n == null
          ? t("нет оценки")
          : `${(n / 1024 / 1024).toLocaleString(getLanguage() === "en" ? "en-GB" : "ru-RU", { maximumFractionDigits: 1 })} MiB`;
    show("Диагностика", () => (
      <>
        <p>{t("Версия {version} · React", { version: APP_VERSION })}</p>
        <p>
          {t("Первое открытие: {ms} мс", {
            ms: Math.round(window.__financeReady?.ms || 0),
          })}
        </p>
        <p>
          {t("Операций: {count} · в очереди: {pending}", {
            count: current.state.entries.length,
            pending: current.pending.length,
          })}
        </p>
        <p>
          {t("Хранилище: {usage} / {quota}", {
            usage: size(estimate?.usage),
            quota: size(estimate?.quota),
          })}
        </p>
        <p>
          {t("Постоянное хранение:")}{" "}
          {persistent === undefined
            ? t("API не поддерживается")
            : persistent
              ? t("предоставлено")
              : permission === "denied"
                ? t("браузер отказал в запросе")
                : t("пока не предоставлено")}
        </p>
        <p>{t("Аудио: {size}", { size: size(media) })}</p>
        <a href="/benchmark.html">{t("Отдельный тест на 10 000 операций")}</a>
      </>
    ));
  };
  const actions = useRef();
  actions.current = { recover, conflicts };
  useEffect(() => {
    const handler = (e) => actions.current[e.detail]?.();
    window.addEventListener("finance-settings", handler);
    return () => window.removeEventListener("finance-settings", handler);
  }, []);
  const exportRef = useRef();
  exportRef.current = (chosen) => exportFile(chosen || period, filters.account);
  useEffect(() => {
    const handler = (e) => {
      e.promise = exportRef.current(e.detail);
    };
    window.addEventListener("finance-export", handler);
    return () => window.removeEventListener("finance-export", handler);
  }, []);
  useEffect(() => {
    if (visible)
      navigator.serviceWorker
        ?.getRegistration()
        .then((r) =>
          setOffline(
            r?.active
              ? "Готово без сети · версия {version}"
              : "Первичная загрузка: оставьте приложение открытым с сетью.",
          ),
        )
        .catch(() =>
          setOffline("Офлайн-кеш недоступен: нужен HTTPS или localhost."),
        );
  }, [visible]);
  const connected = current.settings.connected;
  const button = (label, fn, cls = "secondary", props = {}) => (
    <button type="button" className={cls} {...props} onClick={run(fn)}>
      {label}
    </button>
  );
  return (
    <>
      {visible && (
        <>
          <div className="heading">
            <h1>{t("Настройки")}</h1>
          </div>
          <div className="settings-grid">
            <section className="panel">
              <h3>{t("Учет")}</h3>
              {[
                [
                  "category",
                  "Категории",
                  "Добавить категорию",
                  "list",
                  current.state.categories,
                ],
                [
                  "account",
                  "Счета",
                  "Добавить счет",
                  "wallet",
                  current.state.accounts,
                ],
              ].map(([entity, label, add, icon, items]) => (
                <div className="settings-shortcut" key={entity}>
                  {button(
                    <>
                      <Icon name={icon} />
                      <span className="grow">
                        <strong>{t(label)}</strong>
                        <span className="small">
                          {items.filter((x) => !x.deleted).length} ·{" "}
                          {entity === "account"
                            ? t("наличные и карты")
                            : t("расходы и доходы")}
                        </span>
                      </span>
                      <Icon name="right" />
                    </>,
                    () => setCatalog(entity),
                    "settings-link",
                    { "aria-label": t(label) },
                  )}
                  {button(
                    <Icon name="plus" />,
                    () => setCatalogForm(entity),
                    "icon-button",
                    { "aria-label": t(add) },
                  )}
                </div>
              ))}
            </section>
            <section className="panel">
              <h3>{t("Данные")}</h3>
              <div className="stack spaced">
                {button(t("Импортировать XLSX"), () => {
                  if (!navigator.onLine)
                    throw Error(
                      t(
                        "Для разбора XLSX нужен сервер. Повторите после подключения к сети.",
                      ),
                    );
                  chooseFile(".xlsx", importFile, fail);
                })}
                {button(t("Выгрузить XLSX"), () => exportRef.current())}
                {button(t("Скачать локальную резервную копию"), async () =>
                  download(
                    db.backupFile(await db.backup()),
                    "finance-backup-" + today() + ".json",
                  ),
                )}
                {button(t("Восстановить локальную копию"), () => {
                  const settings = { ...current.settings };
                  chooseFile(
                    ".json",
                    async (file) => {
                      await guard(settings);
                      if (
                        confirm(
                          t(
                            "Заменить локальные данные резервной копией? Сначала скачайте текущую копию.",
                          ),
                        )
                      ) {
                        await db.restore(await db.readBackup(file), settings);
                        await refresh();
                        toast(t("Локальная копия восстановлена"));
                      }
                    },
                    fail,
                  );
                })}
                {button(t("Локальные архивы книг"), archives)}
              </div>
              <p className="small spaced">
                {t(
                  "Для XLSX нужна сеть. Резервная копия JSON доступна без интернета.",
                )}
              </p>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h3>
                  <Icon name="cloud" /> {t("Синхронизация")}
                </h3>
                <span className="badge">
                  {connected ? t("Подключена") : t("Локальный учет")}
                </span>
              </div>
              <p className="small">
                {connected
                  ? t(
                      "{book}. Изменения отправляются при работе приложения с сетью.",
                      { book: current.settings.bookName || t("Общая книга") },
                    )
                  : t(
                      "Подключите общую книгу для совместного учета и помощника. Ручной учет работает и без подключения.",
                    )}
              </p>
              <div className="stack spaced">
                {connected ? (
                  <>
                    {button(t("Участники и приглашение"), members)}
                    {button(t("Изменить имя"), () => {
                      const settings = { ...current.settings };
                      show(
                        "Ваше имя",
                        () => (
                          <Form
                            onSubmit={async (data) => {
                              await guard(settings);
                              await api(
                                "/api/me",
                                { nickname: data.get("nickname") },
                                "PATCH",
                                settings.userId,
                              );
                              setModal(null);
                              await loadMe();
                            }}
                          >
                            <label htmlFor="member-nickname">
                              {t("Имя участника")}
                            </label>
                            <input
                              id="member-nickname"
                              name="nickname"
                              defaultValue={settings.nickname}
                              maxLength={80}
                              required
                            />
                          </Form>
                        ),
                        settings,
                      );
                    })}
                  </>
                ) : (
                  button(t("Подключить синхронизацию"), connect, "primary")
                )}
                {button(t("Присоединиться по коду"), join)}
                {button(t("Войти по личному ключу"), recover, "text-button")}
              </div>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h3>{t("Приложение")}</h3>
                <span className="badge">{APP_VERSION}</span>
              </div>
              <label htmlFor="language">{t("Язык")}</label>
              <select
                id="language"
                value={getLanguage()}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
              <div className="stack spaced">
                {button(t("Проверить обновления"), () =>
                  window.dispatchEvent(
                    new CustomEvent("finance-check-update", { detail: true }),
                  ),
                )}
              </div>
              <p className="small spaced" id="offline-ready">
                {t(offline, { version: APP_VERSION })}
              </p>
              <details className="settings-details">
                <summary>{t("Диагностика и хранение")}</summary>
                <div className="stack spaced">
                  {button(t("Проверить постоянное хранение"), async () => {
                    if (!navigator.storage?.persist) {
                      toast(
                        t(
                          "Этот браузер не поддерживает запрос постоянного хранения. Пользуйтесь синхронизацией и резервными копиями",
                        ),
                      );
                      return;
                    }
                    const granted = await navigator.storage.persist();
                    await db.setMeta(
                      "storage-permission",
                      granted ? "granted" : "denied",
                    );
                    toast(
                      granted
                        ? t("Постоянное хранение разрешено")
                        : t(
                            "Браузер отказал в постоянном хранении. Он может принять решение без системного запроса. Синхронизируйте записи.",
                          ),
                    );
                  })}
                  {button(t("Скорость и диагностика"), diagnostics)}
                </div>
              </details>
              <details className="settings-details">
                <summary>{t("Как установить приложение")}</summary>
                <p className="small spaced">
                  {t("iPhone: Safari → Поделиться → На экран «Домой».")}
                  <br />
                  {t("Android: меню Chrome → Установить приложение.")}
                  <br />
                  {t(
                    "Дождитесь отметки «Готово без сети», затем приложение можно открывать в авиарежиме.",
                  )}
                </p>
              </details>
            </section>
            {connected && (
              <section className="panel">
                <h3>{t("Доступ и интеграции")}</h3>
                <div className="stack spaced">
                  {button(t("Устройства"), sessions)}
                  {button(t("Новый ключ восстановления"), async () => {
                    const settings = { ...current.settings };
                    if (
                      confirm(
                        t(
                          "Создать новый ключ? Старый ключ и QR перестанут работать.",
                        ),
                      )
                    ) {
                      await guard(settings);
                      const result = await api(
                        "/api/recovery-key",
                        {},
                        undefined,
                        settings.userId,
                      );
                      await guard(settings);
                      await showKey(result.recoveryKey, settings);
                    }
                  })}
                  {button(t("MCP и внешние агенты"), integrations)}
                </div>
                <div className="settings-signout">
                  {button(
                    t("Выйти на этом устройстве"),
                    async () => {
                      if (
                        !confirm(
                          t(
                            "Выйти и очистить текущую локальную книгу? Копия будет сохранена в локальном архиве. Сохраните личный ключ для возврата.",
                          ),
                        )
                      )
                        return;
                      const settings = { ...current.settings };
                      await guard(settings);
                      await api("/api/logout", {}, undefined, settings.userId);
                      await guard(settings);
                      await db.switchBook(
                        {
                          bookId: crypto.randomUUID(),
                          bookName: t("Личный учет"),
                          initialLanguage: getLanguage(),
                          connected: false,
                          nickname: t("Я"),
                          revision: 0,
                        },
                        { state: initialState(), revision: 0 },
                        settings,
                      );
                      account.current = null;
                      await refresh();
                    },
                    "text-button",
                  )}
                </div>
              </section>
            )}
          </div>
        </>
      )}
      {catalog && <Catalog entity={catalog} onClose={() => setCatalog(null)} />}{" "}
      {catalogForm && (
        <CatalogForm
          entity={catalogForm}
          onClose={() => setCatalogForm(null)}
          onSaved={() => {
            setCatalogForm(null);
            refresh().catch(fail);
          }}
        />
      )}
      {modal && (
        <Dialog key={modal.id} title={t(modal.title)} onClose={close}>
          {modal.content()}
        </Dialog>
      )}
    </>
  );
}
