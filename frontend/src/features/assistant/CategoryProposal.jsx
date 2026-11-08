import { useEffect, useRef, useState } from "react";
import * as db from "/db.js";
import * as chat from "/chat-db.js";
import { colors, derivedID, icons, validateEntry } from "/model.js";
import { CatalogForm } from "../catalog/Catalog.jsx";
import { iconNames } from "/icons.js";
import { api } from "/sync.js";
import { ColoredIcon, Dialog, Icon } from "../../components/ui.jsx";
import {
  assertAssistantScope,
  ensureAssistant,
  finishAssistant,
  updateAssistant,
} from "../../services/assistant.js";

const favoriteColors = [
  "#ff3e36",
  "#ff8b36",
  "#ffbd1c",
  "#7dad43",
  "#58b8a2",
  "#6598c5",
  "#b08bc0",
  "#ec6db7",
  "#8e9782",
  "#514535",
  "#253747",
  "#e5a0e8",
  "#ff7380",
  "#46b7cf",
  "#435ac2",
  "#d59c68",
  "#dbe6bc",
  "#c5c8ce",
];

export default function CategoryProposal({
  message,
  saved,
  current,
  fail,
  review,
}) {
  const settings = current.settings,
    proposal = message.result.category;
  const [draft, setDraft] = useState(() => ({
    name: proposal.name,
    kind: proposal.kind,
    icon: "dots",
    color: favoriteColors[0] || colors[0],
    styles: [],
    chosen: false,
    ...(message.categoryStyle || saved?.categoryDraft
      ? { ...(message.categoryStyle || saved.categoryDraft), chosen: true }
      : {}),
  }));
  const [manual, setManual] = useState(false),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    automatic = useRef(false),
    request = useRef(null);
  const [error, setError] = useState("");
  const existing = current.state.categories.find(
    (c) =>
      !c.deleted &&
      c.kind === draft.kind &&
      c.name.trim().toLocaleLowerCase() ===
        draft.name.trim().toLocaleLowerCase(),
  );
  const change = (patch) => {
    generation.current++;
    request.current = null;
    setError("");
    setDraft((d) => ({ ...d, ...patch }));
  };
  const persist = async (next) => {
    const result = await ensureAssistant(settings, message.replyTo);
    await updateAssistant(settings, result, { categoryDraft: next });
    const scope = chat.scopeOf(settings),
      key = chat.messageKey(scope, await derivedID(message.replyTo, 100));
    await db.transaction(["meta", "messages"], async (tx) => {
      const latest = (await db.request(tx.objectStore("meta").get("settings")))
        ?.value;
      if (chat.scopeOf(latest) !== scope)
        throw Error("Книга или пользователь изменились");
      const store = tx.objectStore("messages"),
        row = await db.request(store.get(key));
      if (row && !row.deleted && row.status !== "cancelled")
        store.put({ ...row, categoryStyle: next });
    });
  };
  const suggest = async () => {
    if (busy || !draft.name.trim()) return;
    if (!navigator.onLine) {
      setError("Для подбора нужен интернет. Ручной выбор доступен");
      return;
    }
    setBusy(true);
    setError("");
    const version = generation.current;
    try {
      await assertAssistantScope(settings);
      const input = (request.current ||= {
        id: crypto.randomUUID(),
        name: draft.name.trim(),
        kind: draft.kind,
        icons: [...new Set(icons)].map((id) => ({
          id,
          label: iconNames[id] || id,
        })),
        colors: favoriteColors,
        categories: current.state.categories
          .filter((c) => !c.deleted)
          .map(({ name, kind, icon, color }) => ({ name, kind, icon, color })),
        exclude: draft.styles,
      });
      const result = await api(
        `/api/books/${settings.bookId}/category-style`,
        input,
        undefined,
        settings.userId,
      );
      if (
        !Array.isArray(result.suggestions) ||
        result.suggestions.length !== 3 ||
        result.suggestions.some(
          (v) => !icons.includes(v?.icon) || !favoriteColors.includes(v?.color),
        )
      )
        throw Error(
          "ИИ вернул недоступное оформление. Выберите вручную или повторите подбор",
        );
      await assertAssistantScope(settings);
      if (generation.current !== version) return;
      const next = {
        ...draft,
        ...result.suggestions[0],
        styles: result.suggestions,
        chosen: true,
      };
      await persist(next);
      request.current = null;
      setDraft(next);
    } catch (error) {
      if (generation.current === version) {
        setError(error.message);
        fail(error);
      }
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (
      automatic.current ||
      existing ||
      proposal.existingId ||
      !saved?.categoryStylePending ||
      message.categoryStyle ||
      saved.categoryDraft
    )
      return;
    automatic.current = true;
    db.transaction(["meta"], async (tx) => {
      const store = tx.objectStore("meta"),
        rows = (await db.request(store.get("ai-results")))?.value || [];
      const own = rows.find(
        (x) => x.id === message.replyTo && x.scope === chat.scopeOf(settings),
      );
      if (!own?.categoryStylePending) return false;
      store.put({
        id: "ai-results",
        value: rows.map((x) =>
          x === own ? { ...x, categoryStylePending: false } : x,
        ),
      });
      return true;
    })
      .then((claimed) => {
        if (claimed) return suggest();
      })
      .catch(fail);
  }, [saved?.categoryStylePending]);
  const select = async (style) => {
    const next = { ...draft, ...style, chosen: true };
    change(next);
    try {
      await persist(next);
    } catch (error) {
      fail(error);
    }
  };
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ensureAssistant(settings, message.replyTo);
      if (result.saved || result.cancelled) throw Error("Задача уже завершена");
      const category = existing || {
        id: proposal.id,
        name: draft.name.trim(),
        kind: draft.kind,
        icon: draft.icon,
        color: draft.color,
        version: 0,
        deleted: false,
      };
      if (
        !category.name ||
        [...category.name].length > 80 ||
        (!existing &&
          (!draft.chosen ||
            !icons.includes(category.icon) ||
            !/^#[0-9a-f]{6}$/i.test(category.color)))
      )
        throw Error("Проверьте название, значок и цвет категории");
      const entries = (result.result.entries || []).map((e) =>
        e.categoryId === proposal.id
          ? {
              ...e,
              categoryId: category.id,
              kind: category.kind,
              note: e.note || "",
              tags: e.tags || "",
            }
          : { ...e, note: e.note || "", tags: e.tags || "" },
      );
      const pendingCategories = existing ? [] : [category],
        state = {
          ...current.state,
          categories: [...current.state.categories, ...pendingCategories],
        };
      for (const e of entries) validateEntry(e, state);
      if (result.result.receipt && entries.length) {
        const patch = {
          categoryDraft: category,
          pendingCategories,
          result: { ...result.result, entries },
        };
        await updateAssistant(settings, result, patch);
        review({ ...result, ...patch });
      } else
        await finishAssistant(
          { ...result, ownerId: settings.userId },
          entries,
          pendingCategories,
          { foreground: true },
        );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="chat-category" data-category-card={message.replyTo}>
      <h3>{existing ? "Категория уже есть" : "Новая категория"}</h3>
      <label htmlFor={`chat-category-name-${message.replyTo}`}>Название</label>
      <input
        id={`chat-category-name-${message.replyTo}`}
        data-category-field="name"
        data-id={message.replyTo}
        maxLength={80}
        value={draft.name}
        onChange={(e) => change({ name: e.target.value })}
      />
      <label htmlFor={`chat-category-kind-${message.replyTo}`}>Тип</label>
      <select
        id={`chat-category-kind-${message.replyTo}`}
        data-category-field="kind"
        data-id={message.replyTo}
        value={draft.kind}
        onChange={(e) => change({ kind: e.target.value })}
      >
        <option value="expense">Расходы</option>
        <option value="income">Доходы</option>
      </select>
      <div className="category-proposal-preview">
        <ColoredIcon category={existing || draft} />
        <span>
          {existing
            ? "Будет использована существующая категория"
            : draft.name || "Категория"}
        </span>
      </div>
      {!existing && (
        <>
          <div
            className="category-style-options"
            role="group"
            aria-label="Оформление категории"
          >
            {draft.styles.map((v, i) => (
              <button
                type="button"
                key={i}
                data-action="chat-category-style"
                data-id={message.replyTo}
                data-index={i}
                className="category-style-choice"
                aria-pressed={draft.icon === v.icon && draft.color === v.color}
                onClick={() => select(v)}
              >
                <ColoredIcon category={v} />
                <span>{iconNames[v.icon] || v.icon}</span>
              </button>
            ))}
          </div>
          <p className="small" role="status">
            {busy
              ? "Подбираем варианты…"
              : error || "Значок и цвет можно выбрать вручную"}
          </p>
          <div className="category-proposal-tools">
            <button
              type="button"
              className="text-button"
              data-action="chat-category-suggest"
              data-id={message.replyTo}
              disabled={busy || !draft.name.trim()}
              onClick={suggest}
            >
              <Icon name="spark" />
              {draft.styles.length ? "Другие варианты" : "Подобрать с ИИ"}
            </button>
            <button
              type="button"
              className="text-button"
              data-action="chat-category-manual"
              data-id={message.replyTo}
              onClick={() => {
                generation.current++;
                setManual(true);
              }}
            >
              Выбрать вручную
            </button>
          </div>
        </>
      )}
      <button
        type="button"
        className="primary full"
        data-action="chat-category-create"
        data-id={message.replyTo}
        disabled={busy || !draft.name.trim() || (!existing && !draft.chosen)}
        onClick={create}
      >
        {existing
          ? "Использовать"
          : message.result.receipt && message.result.entries?.length
            ? "Проверить чек и создать"
            : "Создать"}
      </button>
      {manual && (
        <CatalogForm
          entity="category"
          draft={{ ...draft, id: proposal.id }}
          expectedScope={settings}
          onClose={() => setManual(false)}
          onPrepared={async (next) => {
            await select(next);
            setManual(false);
          }}
        />
      )}
    </div>
  );
}
