import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { t, getLocale, translateFileError } from "/i18n.js";
import * as db from "/db.js";
import * as chat from "/chat-db.js";
import { cents, currencyCode, formatMoney } from "/model.js";
import { loadChatAudio, syncChat } from "/sync.js";
import { useFinance } from "../FinanceProvider.jsx";
import { Dialog, Icon } from "../components/ui.jsx";
import { useAssistantMedia } from "../features/assistant/media.js";
import Review from "../features/assistant/Review.jsx";
import CategoryProposal from "../features/assistant/CategoryProposal.jsx";
import {
  readDraft,
  readDrafts,
  waitForDraft,
  writeDraft,
} from "../services/draft.js";
import {
  assistantActivity,
  assistantChanged,
  assistantInFlight,
  assertAssistantScope,
  continueAssistant,
  deleteLegacy,
  editQueued,
  ensureAssistant,
  finishAssistant,
  importLegacy,
  legacyMessages,
  sendAssistant,
} from "../services/assistant.js";

function receiptTotal(result) {
  if (!result.total || !result.entries?.length) return "";
  try {
    const currency = currencyCode(result.receiptCurrency);
    if (
      result.entries.some((entry) => currencyCode(entry.currency) !== currency)
    )
      return "";
    return ` · ${t("итог чека {total}", { total: formatMoney(cents(result.total), currency) })}`;
  } catch {
    return "";
  }
}

function Audio({ blob }) {
  const [url, setURL] = useState("");
  useEffect(() => {
    if (!blob) return;
    const value = URL.createObjectURL(blob);
    setURL(value);
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  return url ? (
    <audio
      controls
      preload="none"
      src={url}
      aria-label={t("Прослушать голосовое сообщение")}
    />
  ) : null;
}
const button = (action, label, onClick, extra = {}) => (
  <button
    type="button"
    data-action={action}
    onClick={onClick}
    {...extra}
    aria-label={extra["aria-label"] ? t(extra["aria-label"]) : undefined}
  >
    {typeof label === "string" ? t(label) : label}
  </button>
);

export default function Assistant({ onEntry }) {
  const finance = useFinance();
  return (
    <AssistantScope
      key={chat.scopeOf(finance.current.settings)}
      finance={finance}
      onEntry={onEntry}
    />
  );
}

function AssistantScope({ finance, onEntry }) {
  const { current, fail, toast, revealEntries } = finance,
    settings = current.settings;
  const scope = chat.scopeOf(settings);
  const log = useRef(null),
    scroll = useRef({ top: 0, height: 0, bottom: true, limit: 50 });
  const [text, setText] = useState(""),
    [loaded, setLoaded] = useState(false),
    [entryReturn, setEntryReturn] = useState(null);
  const [messages, setMessages] = useState([]),
    [more, setMore] = useState(false),
    [limit, setLimit] = useState(50),
    [results, setResults] = useState([]),
    [queue, setQueue] = useState([]),
    [context, setContext] = useState(null),
    [legacy, setLegacy] = useState(false),
    [archive, setArchive] = useState([]);
  const [selected, setSelected] = useState(new Set()),
    [selecting, setSelecting] = useState(false),
    [quotes, setQuotes] = useState([]),
    [modal, setModal] = useState(null),
    [sending, setSending] = useState(false),
    [audio, setAudio] = useState({});
  const input = useRef(),
    file = useRef(),
    camera = useRef(),
    sendingRef = useRef(false),
    quotesRef = useRef([]),
    loadSequence = useRef(0),
    mounted = useRef(true),
    activity = useRef({});
  quotesRef.current = quotes;
  const media = useAssistantMedia(scope, fail);
  useLayoutEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height =
        Math.min(input.current.scrollHeight, 120) + "px";
    }
    window.dispatchEvent(new Event("finance-chat-layout"));
  });
  activity.current = {
    text,
    attachment: media.attachment,
    recording: media.recording,
    selecting,
    quotes,
    entryReturn,
    modal,
  };
  useEffect(
    () =>
      assistantActivity((saved) => {
        const a = activity.current;
        return (
          a.selecting ||
          a.quotes.length > 0 ||
          !!a.text.trim() ||
          !!a.attachment ||
          a.recording ||
          !!a.modal ||
          (a.entryReturn && a.entryReturn.draft.id !== saved.entryDraftId)
        );
      }),
    [],
  );
  const update = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const [page, allResults, allQueue, ctx, draft] = await Promise.all([
      chat.messages(settings, limit),
      db.meta("ai-results"),
      db.meta("ai-queue"),
      db.meta("ai-context:" + settings.bookId),
      readDraft(settings, "entry"),
    ]);
    const rows = await legacyMessages(
      settings,
      allResults || [],
      allQueue || [],
    );
    const checked = quotesRef.current,
      latestQuotes = await Promise.all(
        checked.map((q) => chat.message(settings, q.id)),
      );
    if (!mounted.current || sequence !== loadSequence.current) return;
    setMessages(page.messages);
    setMore(page.more);
    setResults(allResults || []);
    setQueue(
      (allQueue || []).filter(
        (x) =>
          x.bookId === settings.bookId &&
          (!x.ownerId || x.ownerId === settings.userId),
      ),
    );
    setContext(ctx?.pending && ctx.userId === settings.userId ? ctx : null);
    setEntryReturn(draft || null);
    setArchive(rows);
    const removed = new Set(
      checked
        .filter((q, i) => !latestQuotes[i] || latestQuotes[i].deleted)
        .map((q) => q.id),
    );
    setQuotes((old) =>
      removed.size ? old.filter((q) => !removed.has(q.id)) : old,
    );
  }, [scope, limit]);
  useEffect(() => {
    mounted.current = true;
    const loadDraft = () =>
      readDrafts(settings)
        .then(({ text: value, entryReturn: draft }) => {
          if (mounted.current) {
            setText(value || "");
            setLoaded(true);
            setEntryReturn(draft || null);
            if (draft) requestAnimationFrame(() => input.current?.focus());
          }
        })
        .catch(fail);
    loadDraft();
    window.addEventListener("finance-assistant-draft", loadDraft);
    return () => {
      mounted.current = false;
      window.removeEventListener("finance-assistant-draft", loadDraft);
    };
  }, [scope]);
  useEffect(() => {
    const refresh = () => update().catch(fail);
    for (const name of [
      "finance-assistant-updated",
      "finance-chat-updated",
      "finance-updated",
    ])
      window.addEventListener(name, refresh);
    refresh();
    return () => {
      for (const name of [
        "finance-assistant-updated",
        "finance-chat-updated",
        "finance-updated",
      ])
        window.removeEventListener(name, refresh);
    };
  }, [update, fail]);
  const run = (fn) => Promise.resolve().then(fn).catch(fail);
  const changeText = (value) => {
    if (sendingRef.current) return;
    setText(value);
    writeDraft(settings, value).catch(fail);
  };
  const rows = legacy ? archive : messages;
  useLayoutEffect(() => {
    const el = log.current,
      previous = scroll.current;
    if (!el) return;
    if (previous.limit !== limit)
      el.scrollTop = previous.top + el.scrollHeight - previous.height;
    else if (previous.bottom) el.scrollTop = el.scrollHeight;
    scroll.current = {
      top: el.scrollTop,
      height: el.scrollHeight,
      bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 80,
      limit,
    };
  }, [rows]);
  const answer = (m) => {
    const local = results.find((x) => x.id === m.replyTo && x.scope === scope);
    const applied =
      m.status !== "cancelled" &&
      !local?.cancelled &&
      (m.status === "applied" || m.localSaved || local?.saved);
    return applied && m.result?.category
      ? t("Категория подтверждена")
      : applied && m.result?.entries?.length
        ? t("Операции добавлены")
        : m.text;
  };
  const pick = (id) =>
    id
      ? rows.filter((m) => m.id === id)
      : rows.filter((m) => selected.has(m.id));
  const clearSelection = () => {
    setSelected(new Set());
    setSelecting(false);
  };
  const choose = (id) => {
    setSelecting(true);
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      else fail(Error("Выберите до 100 сообщений"));
      return next;
    });
    setModal(null);
  };
  const quote = (id) =>
    run(async () => {
      const chosen = pick(id);
      if (chosen.some((m) => m.legacy))
        throw Error("Сначала перенесите прежнюю переписку в личную историю");
      const next = [
        ...new Map([...quotes, ...chosen].map((m) => [m.id, m])).values(),
      ];
      chat.checkQuotes(next);
      setQuotes(next);
      clearSelection();
      setModal(null);
      input.current?.focus();
    });
  const copy = (id) =>
    run(async () => {
      const value = pick(id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .filter(chat.quoteText)
        .map(
          (m) =>
            `${t(m.role === "user" ? "Вы" : "Помощник")} · ${new Date(m.createdAt).toLocaleString(getLocale())}\n${chat.quoteText(m)}`,
        )
        .join("\n\n");
      if (!value) throw Error("В выбранных сообщениях нет текста");
      await navigator.clipboard.writeText(value);
      setModal(null);
      toast("Текст скопирован");
    });
  const remove = (ids, clear = false) =>
    setModal({ type: "delete", ids, clear });
  const doRemove = async () => {
    const { ids, clear } = modal;
    await assertAssistantScope(settings);
    if (legacy) await deleteLegacy(settings, archive, ids, clear);
    else await chat.remove(settings, ids, clear);
    clearSelection();
    setQuotes((old) => old.filter((m) => !clear && !ids.includes(m.id)));
    setModal(null);
    assistantChanged();
    await update();
    syncChat().catch(fail);
    toast("Переписка обновлена");
  };
  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      if (sendingRef.current || !loaded) return;
      sendingRef.current = true;
      setSending(true);
      try {
        const attachment = await media.ready();
        await waitForDraft(settings);
        const latestQuotes = await Promise.all(
          quotes.map((m) => chat.message(settings, m.id)),
        );
        chat.checkQuotes(latestQuotes.filter(Boolean));
        if (latestQuotes.some((m) => !m || m.deleted))
          throw Error("Цитируемое сообщение удалено");
        await sendAssistant(settings, {
          text,
          attachment,
          quotes: latestQuotes,
          entryReturn,
          accountId:
            finance.filters.account ||
            current.state.accounts.find((x) => !x.deleted)?.id,
        });
        if (mounted.current) {
          setText("");
          media.clear();
          setQuotes([]);
          setLegacy(false);
          await update();
          toast(
            navigator.onLine
              ? "Запрос отправляется"
              : "Запрос сохранён до подключения",
          );
        }
      } finally {
        sendingRef.current = false;
        if (mounted.current) setSending(false);
      }
    });
  };
  const play = (m) =>
    run(async () => {
      const blob = m.legacyAudio
        ? chat.base64Blob(m.legacyAudio)
        : m.legacyMediaKey
          ? (
              await chat.media(
                { userId: "legacy", bookId: settings.bookId },
                m.id,
              )
            )?.blob
          : await loadChatAudio(settings, m.id);
      if (!blob) throw Error("Эта запись больше не доступна на устройстве");
      await assertAssistantScope(settings);
      const latest = m.legacy ? m : await chat.message(settings, m.id);
      if (!latest || latest.deleted) return;
      setAudio((old) => ({ ...old, [m.id]: blob }));
    });
  const openReview = (id) =>
    run(async () => {
      const saved = await ensureAssistant(settings, id);
      if (saved.saved) {
        await revealEntries(
          saved.savedIDs || saved.result.entries.map((e) => e.id),
          settings.bookId,
        );
        return;
      }
      setModal({ type: "review", saved });
    });
  const detach = () =>
    run(async () => {
      await db.transaction(["meta"], async (tx) => {
        const store = tx.objectStore("meta"),
          latest = (await db.request(store.get("settings")))?.value;
        if (chat.scopeOf(latest) !== scope)
          throw Error("Книга или пользователь изменились");
        store.put({ id: "ai-context:" + settings.bookId, value: null });
        store.put({ id: "ai-active:" + scope, value: null });
      });
      assistantChanged();
    });
  const resultActions = (m) => {
    const result = m.result,
      saved = results.find(
        (x) =>
          x.id === m.replyTo &&
          x.bookId === settings.bookId &&
          (!x.ownerId || x.ownerId === settings.userId) &&
          (!x.scope || x.scope === scope),
      );
    if (!result) return null;
    if (m.status === "cancelled" || saved?.cancelled)
      return (
        <p className="small spaced">
          {t(
            m.legacy
              ? "Прежний результат · без повторного выполнения"
              : "Задача отменена",
          )}
        </p>
      );
    if (m.status === "applied" || m.localSaved || saved?.saved)
      return result.entries?.length
        ? button(
            "ai-review",
            "Посмотреть операции",
            () => openReview(m.replyTo),
            { className: "secondary spaced", "data-id": m.replyTo },
          )
        : null;
    if (
      rows.some(
        (other) =>
          other.role === "assistant" &&
          other.taskId === m.taskId &&
          other.replyTo !== m.replyTo &&
          Date.parse(other.createdAt) > Date.parse(m.createdAt),
      )
    )
      return (
        <p className="small spaced">
          {t("Уточнение продолжено в следующем сообщении")}
        </p>
      );
    if (result.category)
      return (
        <CategoryProposal
          key={m.id}
          message={m}
          saved={saved}
          current={current}
          fail={fail}
          review={(value) => setModal({ type: "review", saved: value })}
        />
      );
    return (
      <>
        {!!result.question?.choices?.length && (
          <div className="clarification-choices">
            {result.question.choices.map((c) =>
              button(
                "ai-choice",
                <>{c.label}</>,
                () =>
                  run(async () => {
                    const value = await ensureAssistant(settings, m.replyTo);
                    if (
                      value.saved ||
                      value.result.receipt ||
                      !value.result.question?.choices?.some(
                        (x) => x.categoryId === c.categoryId,
                      )
                    )
                      return;
                    await finishAssistant(
                      { ...value, ownerId: settings.userId },
                      value.result.entries.map((e) => ({
                        ...e,
                        categoryId: c.categoryId,
                      })),
                      [],
                      { foreground: true },
                    );
                  }),
                {
                  key: c.categoryId,
                  className: "secondary",
                  "data-id": m.replyTo,
                  "data-category": c.categoryId,
                },
              ),
            )}
          </div>
        )}
        {result.action === "clarify" &&
          context?.taskId !== m.taskId &&
          button(
            "chat-continue",
            "Ответить на уточнение",
            () =>
              run(async () => {
                await continueAssistant(settings, m);
                await update();
                input.current?.focus();
              }),
            { className: "text-button spaced", "data-id": m.id },
          )}
        {!!result.entries?.length && result.action !== "clarify" && (
          <>
            <p className="small spaced">
              {t("{count} операций", { count: result.entries.length })}
              {receiptTotal(result)}
            </p>
            {button(
              "ai-review",
              "Проверить и сохранить",
              () => openReview(m.replyTo),
              { className: "secondary spaced", "data-id": m.replyTo },
            )}
          </>
        )}
      </>
    );
  };
  return (
    <div className="assistant">
      <div className="chat-heading">
        <h1>{t(legacy ? "Прежняя переписка" : "Помощник")}</h1>
        {button(
          "chat-menu",
          <Icon name="dots" />,
          () => setModal({ type: "menu" }),
          { className: "icon-button", "aria-label": "Меню переписки" },
        )}
      </div>
      {selecting && (
        <div
          className="chat-selection"
          role="toolbar"
          aria-label={t("Действия с выбранными сообщениями")}
        >
          <span>{t("Выбрано: {count}", { count: selected.size })}</span>
          {button("chat-quote", "Цитировать", () => quote(), {
            className: "text-button",
            disabled: !selected.size,
          })}
          {button("chat-copy", "Копировать", () => copy(), {
            className: "text-button",
            disabled: !selected.size,
          })}
          {button("chat-delete", "Удалить", () => remove([...selected]), {
            className: "text-button",
            disabled: !selected.size,
          })}
          {button(
            "chat-selection-close",
            <Icon name="close" />,
            clearSelection,
            { className: "icon-button", "aria-label": "Закончить выбор" },
          )}
        </div>
      )}
      {legacy ? (
        <aside className="draft-banner">
          <span>{t("Сохранена на этом устройстве")}</span>
          {button(
            "chat-current",
            "Вернуться",
            () => {
              setLegacy(false);
              clearSelection();
            },
            { className: "text-button" },
          )}
          {settings.connected &&
            button(
              "chat-import",
              "Перенести в личную историю",
              () => setModal({ type: "import" }),
              { className: "text-button" },
            )}
        </aside>
      ) : (
        !!archive.length &&
        button(
          "chat-legacy",
          t("Прежняя переписка · {count}", { count: archive.length }),
          () => {
            setLegacy(true);
            clearSelection();
          },
          { className: "text-button legacy-link" },
        )
      )}
      {entryReturn && !selecting && (
        <aside className="draft-banner">
          <span>{t("Черновик операции сохранён")}</span>
          {button(
            "entry-return",
            "Назад к операции",
            () => onEntry(entryReturn),
            { className: "text-button" },
          )}
        </aside>
      )}
      <div
        ref={log}
        className="chat-messages"
        role="log"
        aria-label={t("Сообщения помощника")}
        onScroll={(event) => {
          const el = event.currentTarget;
          if (more && !legacy && scroll.current.top >= 24 && el.scrollTop < 24)
            setLimit((n) => n + 50);
          scroll.current = {
            top: el.scrollTop,
            height: el.scrollHeight,
            bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 80,
            limit: scroll.current.limit,
          };
        }}
      >
        {!legacy &&
          more &&
          button(
            "chat-older",
            "Предыдущие сообщения",
            () => setLimit((n) => n + 50),
            { className: "text-button chat-older" },
          )}
        {rows.length ? (
          rows.map((m, i) => {
            const queued = queue.find((x) => x.input.id === m.id),
              date = new Date(m.createdAt),
              prior =
                rows[i - 1] &&
                new Date(rows[i - 1].createdAt).toLocaleDateString(getLocale());
            return (
              <Fragment key={m.id}>
                {date.toLocaleDateString(getLocale()) !== prior && (
                  <div className="chat-date">
                    {date.toLocaleDateString(getLocale(), {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </div>
                )}
                <article
                  className={`chat-message ${m.role === "user" ? "chat-user" : "assistant-result"} ${selected.has(m.id) ? "message-selected" : ""}`}
                  data-message-id={m.id}
                  aria-label={t(
                    m.role === "user" ? "Ваше сообщение" : "Ответ помощника",
                  )}
                >
                  {selecting &&
                    button(
                      "chat-select",
                      selected.has(m.id) ? "✓" : "○",
                      () => choose(m.id),
                      {
                        className: "message-select",
                        "data-id": m.id,
                        "aria-label": "Выбрать сообщение",
                        "aria-pressed": selected.has(m.id),
                      },
                    )}
                  <div className="message-body">
                    <p>{answer(m)}</p>
                    {m.audio && (
                      <>
                        <span className="small">
                          {t("Голосовое сообщение")}
                        </span>
                        {audio[m.id] ? (
                          <Audio blob={audio[m.id]} />
                        ) : m.media?.available === false ? (
                          <p className="small audio-expired">
                            {t("Срок хранения аудио истёк")}
                          </p>
                        ) : (
                          button(
                            m.legacyMediaKey ? "chat-play-legacy" : "chat-play",
                            <>
                              <Icon name="play" />
                              {t("Прослушать")}
                            </>,
                            () => play(m),
                            {
                              className: "secondary chat-play",
                              "data-id": m.id,
                              "aria-label": "Прослушать голосовое сообщение",
                            },
                          )
                        )}
                      </>
                    )}
                    {m.transcript && (
                      <p className="voice-transcript">{m.transcript}</p>
                    )}
                    {queued && (
                      <div className="ai-queued">
                        <p className="small" role="status">
                          {translateFileError(
                            queued.error ||
                              (assistantInFlight() === m.id
                                ? "Обрабатывается"
                                : queued.paused
                                  ? "Отправка приостановлена"
                                  : "В очереди"),
                          )}
                        </p>
                        {(queued.error || queued.paused) &&
                          button(
                            "ai-retry",
                            "Повторить",
                            () =>
                              run(() =>
                                editQueued(settings, m.id, {
                                  attempts: 0,
                                  paused: false,
                                  retryAt: 0,
                                  error: "",
                                }),
                              ),
                            { className: "text-button", "data-id": m.id },
                          )}
                        {button("ai-cancel", "Отменить", () => remove([m.id]), {
                          className: "text-button",
                          "data-id": m.id,
                        })}
                      </div>
                    )}
                    {m.role === "assistant" && resultActions(m)}
                  </div>
                  <div className="message-meta">
                    <time
                      dateTime={m.createdAt}
                      title={date.toLocaleString(getLocale())}
                    >
                      {m.legacy && m.role === "assistant"
                        ? t("Архив")
                        : date.toLocaleTimeString(getLocale(), {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                    </time>
                    {button(
                      selecting ? "chat-select" : "chat-message-menu",
                      <Icon name="dots" />,
                      () =>
                        selecting
                          ? choose(m.id)
                          : setModal({ type: "message", message: m }),
                      {
                        className: "icon-button",
                        "data-id": m.id,
                        "aria-label": selecting
                          ? "Выбрать сообщение"
                          : "Действия с сообщением",
                      },
                    )}
                  </div>
                </article>
              </Fragment>
            );
          })
        ) : (
          <div className="assistant-intro">
            <span className="brand-mark">✧</span>
            <h2>{t("Расскажите, что потратили")}</h2>
            <p className="small">
              {t(
                "Текст или голос — помощник добавит понятную операцию или уточнит детали. Чек проверите перед сохранением.",
              )}
            </p>
            <div className="suggestions">
              {[
                "Вчера продукты 850 рублей",
                "Сколько потратили на кафе в этом месяце?",
              ].map((value) =>
                button(
                  "suggestion",
                  value,
                  () => {
                    changeText(t(value));
                    input.current?.focus();
                  },
                  { key: value, className: "pill", "data-text": value },
                ),
              )}
            </div>
          </div>
        )}
      </div>
      {!settings.connected && (
        <p className="small">
          {t(
            "Подключите синхронизацию в настройках для работы помощника. Без сети запрос останется в очереди.",
          )}
        </p>
      )}
      <form id="ai-form" className="ai-input" onSubmit={submit}>
        {!legacy && context && (
          <div className="pending-context">
            <span>{t("Ответ на уточнение")}</span>
            {button("chat-detach", <Icon name="close" />, detach, {
              className: "icon-button",
              "aria-label": "Начать независимый запрос",
            })}
          </div>
        )}
        {!!quotes.length && (
          <div className="composer-quotes">
            {quotes.map((m) => (
              <div className="composer-quote" key={m.id}>
                <div>
                  <strong>{t(m.role === "user" ? "Вы" : "Помощник")}</strong>
                  <p>{chat.quoteText(m)}</p>
                </div>
                {button(
                  "chat-unquote",
                  <Icon name="close" />,
                  () => setQuotes((q) => q.filter((x) => x.id !== m.id)),
                  {
                    className: "icon-button",
                    "data-id": m.id,
                    "aria-label": "Убрать цитату",
                  },
                )}
              </div>
            ))}
          </div>
        )}
        <div id="ai-attachment" className="attachment">
          {media.recording ? (
            <div className="recording" role="status">
              <span className="record-dot" />
              <strong>{t("Идёт запись")}</strong>{" "}
              <time id="record-time">
                {t("{count} с", { count: media.seconds })}
              </time>
              {button(
                "ai-abort",
                <Icon name="close" />,
                () => media.stop(true),
                { className: "icon-button", "aria-label": "Отменить запись" },
              )}
            </div>
          ) : media.busy ? (
            <p role="status">{t("Обрабатываем вложение…")}</p>
          ) : (
            media.attachment && (
              <div className="audio-preview">
                <span>
                  {media.attachment.duration != null
                    ? t("Голос · {count} сек.", {
                        count: media.attachment.duration,
                      })
                    : media.attachment.fileName != null
                      ? t("Фото чека · {name}", {
                          name: media.attachment.fileName,
                        })
                      : t(media.attachment.label)}
                </span>
                {media.attachment.original && (
                  <Audio blob={media.attachment.original} />
                )}
                {media.attachment.error && (
                  <>
                    <p className="small">{t(media.attachment.error)}</p>
                    {button(
                      "ai-prepare",
                      "Повторить подготовку",
                      () => run(media.prepare),
                      { className: "text-button" },
                    )}
                  </>
                )}
                {button("ai-clear", "Удалить", media.clear, {
                  className: "text-button",
                })}
                {media.attachment.original &&
                  button("ai-record", "Перезаписать", () => run(media.record), {
                    className: "text-button",
                  })}
              </div>
            )
          )}
        </div>
        <label hidden htmlFor="ai-text">
          {t("Сообщение помощнику")}
        </label>
        <div className="ai-compose-row ai-tools">
          {button(
            "ai-photo",
            <Icon name="photo" />,
            () => setModal({ type: "photo" }),
            { className: "icon-button", "aria-label": "Приложить фото чека" },
          )}
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const selected = e.target.files[0];
              e.target.value = "";
              if (selected) run(() => media.image(selected));
            }}
          />
          <input
            ref={camera}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const selected = e.target.files[0];
              e.target.value = "";
              if (selected) run(() => media.image(selected));
            }}
          />
          <textarea
            ref={input}
            data-draft-scope={scope}
            rows="1"
            id="ai-text"
            placeholder={t("Сообщение…")}
            maxLength={4096}
            value={text}
            disabled={!loaded || sending}
            onChange={(e) => changeText(e.target.value)}
          />
          {button(
            media.recording ? "ai-stop" : "ai-record",
            <Icon name={media.recording ? "stop" : "mic"} />,
            () => run(media.record),
            {
              className: `icon-button ${media.recording ? "record-stop" : ""}`,
              "aria-label": media.recording
                ? "Остановить запись"
                : "Записать голос",
              "aria-pressed": media.recording,
            },
          )}
          <button
            className="primary icon-button"
            type="submit"
            aria-label={t("Отправить")}
            disabled={sending || !loaded}
          >
            <Icon name="arrowUp" />
          </button>
        </div>
        <p className="small" id="ai-status">
          {sending && media.busy
            ? t("Подготовка голоса…")
            : queue.length
              ? t("Запросов в очереди: {count}", { count: queue.length })
              : ""}
        </p>
      </form>
      {modal?.type === "review" && (
        <Review
          saved={modal.saved}
          current={current}
          close={() => setModal(null)}
          fail={fail}
        />
      )}
      {modal && modal.type !== "review" && (
        <Dialog
          title={t(
            {
              menu: "Переписка",
              message: "Сообщение",
              delete: modal.clear
                ? "Очистить переписку?"
                : "Удалить сообщения?",
              import: "Перенести прежнюю переписку?",
              photo: "Фото чека",
            }[modal.type],
          )}
          onClose={() => setModal(null)}
        >
          {modal.type === "menu" && (
            <>
              <div className="stack">
                {button(
                  "chat-select-mode",
                  "Выбрать сообщения",
                  () => {
                    setSelecting(true);
                    setModal(null);
                  },
                  { className: "secondary" },
                )}
                {button(
                  "chat-clear-history",
                  "Очистить переписку",
                  () => remove([], true),
                  { className: "danger" },
                )}
                {button(
                  legacy ? "chat-current" : "chat-legacy",
                  legacy
                    ? "Вернуться к помощнику"
                    : "Прежняя локальная переписка",
                  () => {
                    setLegacy(!legacy);
                    clearSelection();
                    setModal(null);
                  },
                  { className: "secondary" },
                )}
              </div>
              <p className="small spaced">
                {t(
                  "История личная. Другие участники книги её не видят. В контекст идут только ваши цитаты и текущее уточнение.",
                )}
              </p>
            </>
          )}
          {modal.type === "message" && (
            <div className="stack">
              {button(
                "chat-quote",
                "Цитировать",
                () => quote(modal.message.id),
                {
                  className: "secondary",
                  disabled:
                    modal.message.legacy || !chat.quoteText(modal.message),
                  "data-id": modal.message.id,
                },
              )}
              {button(
                "chat-copy",
                "Скопировать",
                () => copy(modal.message.id),
                {
                  className: "secondary",
                  disabled: !chat.quoteText(modal.message),
                  "data-id": modal.message.id,
                },
              )}
              {button(
                "chat-select",
                "Выбрать",
                () => choose(modal.message.id),
                { className: "secondary", "data-id": modal.message.id },
              )}
              {button(
                "chat-delete",
                "Удалить",
                () => remove([modal.message.id]),
                { className: "danger", "data-id": modal.message.id },
              )}
            </div>
          )}
          {modal.type === "delete" && (
            <>
              <p>
                {modal.clear
                  ? t("Будут удалены сообщения этой книги")
                  : t("Выбрано сообщений: {count}", {
                      count: modal.ids.length,
                    })}{" "}
                {t(legacy ? "на этом устройстве" : "на всех ваших устройствах")}
                . {t("Незавершённые запросы отменятся.")}
              </p>
              <p className="small spaced">
                {t("Уже сохранённые операции и категории останутся в книге.")}
              </p>
              <div className="form-actions">
                {button("close", "Отмена", () => setModal(null), {
                  className: "secondary",
                })}
                {button("confirm-delete", "Удалить", () => run(doRemove), {
                  className: "danger",
                })}
              </div>
            </>
          )}
          {modal.type === "import" && (
            <>
              <p>
                {t(
                  "Сообщения за последние 90 дней попадут в вашу личную историю. Старые задачи не выполнятся повторно.",
                )}
              </p>
              <p className="small spaced">
                {t(
                  "Проверьте, что это ваша переписка: прежний архив не содержит ID владельца.",
                )}
              </p>
              <div className="form-actions">
                {button(
                  "chat-import-confirm",
                  "Перенести",
                  () =>
                    run(async () => {
                      await importLegacy(settings, archive);
                      setLegacy(false);
                      setModal(null);
                      await update();
                      toast("Переписка перенесена");
                    }),
                  { className: "primary" },
                )}
              </div>
            </>
          )}
          {modal.type === "photo" && (
            <div className="stack">
              {button(
                "ai-file",
                <>
                  <Icon name="photo" />
                  {t("Выбрать файл")}
                </>,
                () => {
                  setModal(null);
                  file.current.click();
                },
                { className: "secondary" },
              )}
              {button(
                "ai-camera",
                <>
                  <Icon name="camera" />
                  {t("Сделать фото")}
                </>,
                () => {
                  setModal(null);
                  camera.current.click();
                },
                { className: "secondary" },
              )}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
