import { useEffect, useRef, useState } from "react";
import * as db from "/db.js";
import { api, sync } from "/sync.js";
import {
  cents,
  decimal,
  colors,
  icons,
  currencies,
  currencyCode,
  formatMoney,
  summarizeByCurrency,
} from "/model.js";
import { iconNames, iconGroups } from "/icons.js";
import { useFinance } from "../../FinanceProvider.jsx";
import { Dialog, Icon, ColoredIcon } from "../../components/ui.jsx";

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
const palette = [
  "#9915ad",
  "#af18bc",
  "#c525d3",
  "#d348e2",
  "#df75e6",
  "#e9a1eb",
  "#a31a72",
  "#b33783",
  "#bf5292",
  "#cd75a7",
  "#d99abc",
  "#e4b5cd",
  "#ec358f",
  "#ec479c",
  "#ed5aab",
  "#ee70b8",
  "#ef8ac8",
  "#f2a3d7",
  "#c10b55",
  "#d50c69",
  "#ec0c85",
  "#f42b9e",
  "#f965b2",
  "#faa1ce",
  "#eb463e",
  "#ee5c56",
  "#ef736d",
  "#f28e87",
  "#f6aba4",
  "#fac6bc",
  "#ff8b36",
  "#ff9a48",
  "#ffaa65",
  "#ffba83",
  "#ffcca0",
  "#ffddbd",
  "#a97e00",
  "#c99700",
  "#e9b000",
  "#ffbd1c",
  "#ffce59",
  "#ffdf95",
  "#41742e",
  "#5e9237",
  "#7dad43",
  "#97c263",
  "#b4d48d",
  "#d0e4b5",
  "#257c69",
  "#379780",
  "#58b8a2",
  "#7acbb8",
  "#a2dccd",
  "#c6e9e0",
  "#376394",
  "#4b7fb0",
  "#6598c5",
  "#87b3d6",
  "#accbe3",
  "#cddfec",
  "#881111",
  "#b61616",
  "#e31c1c",
  "#ea5353",
  "#f08989",
  "#f7bfbf",
  "#883911",
  "#b64b16",
  "#e35e1c",
  "#ea8553",
  "#f0ab89",
  "#f7d2bf",
  "#886011",
  "#b68116",
  "#e3a11c",
  "#eab753",
  "#f0ce89",
  "#f7e5bf",
  "#888811",
  "#b6b616",
  "#e3e31c",
  "#eaea53",
  "#f0f089",
  "#f7f7bf",
  "#608811",
  "#81b616",
  "#a1e31c",
  "#b7ea53",
  "#cef089",
  "#e5f7bf",
  "#398811",
  "#4bb616",
  "#5ee31c",
  "#85ea53",
  "#abf089",
  "#d2f7bf",
  "#118811",
  "#16b616",
  "#1ce31c",
  "#53ea53",
  "#89f089",
  "#bff7bf",
  "#118839",
  "#16b64b",
  "#1ce35e",
  "#53ea85",
  "#89f0ab",
  "#bff7d2",
  "#118860",
  "#16b681",
  "#1ce3a1",
  "#53eab7",
  "#89f0ce",
  "#bff7e5",
  "#118888",
  "#16b6b6",
  "#1ce3e3",
  "#53eaea",
  "#89f0f0",
  "#bff7f7",
  "#116088",
  "#1681b6",
  "#1ca1e3",
  "#53b7ea",
  "#89cef0",
  "#bfe5f7",
  "#113988",
  "#164bb6",
  "#1c5ee3",
  "#5385ea",
  "#89abf0",
  "#bfd2f7",
  "#111188",
  "#1616b6",
  "#1c1ce3",
  "#5353ea",
  "#8989f0",
  "#bfbff7",
  "#391188",
  "#4b16b6",
  "#5e1ce3",
  "#8553ea",
  "#ab89f0",
  "#d2bff7",
  "#601188",
  "#8116b6",
  "#a11ce3",
  "#b753ea",
  "#ce89f0",
  "#e5bff7",
  "#881188",
  "#b616b6",
  "#e31ce3",
  "#ea53ea",
  "#f089f0",
  "#f7bff7",
  "#881160",
  "#b61681",
  "#e31ca1",
  "#ea53b7",
  "#f089ce",
  "#f7bfe5",
  "#881139",
  "#b6164b",
  "#e31c5e",
  "#ea5385",
  "#f089ab",
  "#f7bfd2",
  "#141414",
  "#232323",
  "#373737",
  "#4b4b4b",
  "#5f5f5f",
  "#737373",
  "#878787",
  "#9b9b9b",
  "#b4b4b4",
  "#c8c8c8",
  "#dcdcdc",
  "#f0f0f0",
  "#ff3e36",
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
const allIcons = [...new Set(icons)];

export function Catalog({ entity, onClose }) {
  const { current, fail } = useFinance();
  const scope = useRef({
    bookId: current.settings.bookId,
    userId: current.settings.userId,
  });
  const edit = async (item) => {
    try {
      const settings = await db.meta("settings");
      if (
        settings.bookId !== scope.current.bookId ||
        settings.userId !== scope.current.userId
      )
        throw Error("Книга изменилась. Откройте список заново");
      setEditing(item);
    } catch (error) {
      fail(error);
    }
  };
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [editing, setEditing] = useState(null);
  const account = entity === "account";
  const balances = account
    ? summarizeByCurrency(current.state, current.state.entries).balances
    : null;
  const items = (
    account ? current.state.accounts : current.state.categories
  ).filter(
    (x) =>
      !x.deleted &&
      x.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (!kind || x.kind === kind),
  );
  if (editing)
    return (
      <CatalogForm
        entity={entity}
        item={editing.id ? editing : undefined}
        expectedScope={scope.current}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
    );
  return (
    <Dialog title={account ? "Счета" : "Категории"} onClose={onClose}>
      <div className="catalog-toolbar">
        <button
          type="button"
          className="secondary"
          data-action={account ? "new-account" : "new-category"}
          onClick={() => edit({})}
        >
          <Icon name="plus" />
          {account ? "Новый счет" : "Новая категория"}
        </button>
      </div>
      <label htmlFor="catalog-search">Поиск</label>
      <input
        id="catalog-search"
        type="search"
        placeholder="По названию"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!account && (
        <>
          <label htmlFor="catalog-kind">Тип категории</label>
          <select
            id="catalog-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">Все категории</option>
            <option value="expense">Расходы</option>
            <option value="income">Доходы</option>
          </select>
        </>
      )}
      <div className="catalog-list">
        {items.map((x) => (
          <div className="setting-row" data-catalog-id={x.id} key={x.id}>
            {account ? (
              <span className="category-icon">
                <Icon name="wallet" />
              </span>
            ) : (
              <ColoredIcon category={x} />
            )}
            <span className="grow">
              {x.name}
              {account && (
                <span className="small">
                  {" "}
                  · Остаток:{" "}
                  {formatMoney(balances[x.id], currencyCode(x.currency))}
                </span>
              )}
              {!account && (
                <span className="small">
                  {" "}
                  · {x.kind === "expense" ? "расход" : "доход"}
                </span>
              )}
            </span>
            <button
              type="button"
              className="icon-button"
              data-action={account ? "edit-account" : "edit-category"}
              data-id={x.id}
              aria-label={`Изменить ${account ? "счет" : "категорию"} ${x.name}`}
              onClick={() => edit(x)}
            >
              <Icon name="edit" />
            </button>
          </div>
        ))}
      </div>
      {!items.length && (
        <p className="small spaced" id="catalog-empty">
          Ничего не найдено
        </p>
      )}
    </Dialog>
  );
}

export function CatalogForm({
  entity,
  item,
  onClose,
  onSaved,
  initialKind,
  draft,
  onPrepared,
  expectedScope,
}) {
  const { current, refresh, fail, toast } = useFinance();
  const scope = useRef(
    expectedScope || {
      bookId: current.settings.bookId,
      userId: current.settings.userId,
    },
  );
  const latest = useRef(current);
  latest.current = current;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const account = entity === "account",
    existing = !!item?.id;
  const [form, setForm] = useState(() => ({
    id: crypto.randomUUID(),
    name: "",
    version: 0,
    deleted: false,
    ...(account
      ? { opening: "0.00", currency: "RUB" }
      : { kind: initialKind || "expense", color: colors[0], icon: "dots" }),
    ...draft,
    ...item,
  }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("popular");
  const variants = useRef({ key: "", list: [], previous: [], input: null });
  const revision = useRef(0);
  const set = (name, value) => {
    if (name === "name" || name === "kind") revision.current++;
    setForm((prev) => ({ ...prev, [name]: value }));
  };
  const guard = async () => {
    const settings = await db.meta("settings");
    if (
      !alive.current ||
      latest.current.settings.bookId !== scope.current.bookId ||
      latest.current.settings.userId !== scope.current.userId ||
      settings.bookId !== scope.current.bookId ||
      settings.userId !== scope.current.userId
    )
      throw Error("Книга или пользователь изменились. Откройте форму заново");
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
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await guard();
      const next = { ...form, name: form.name.trim() };
      if (!next.name) throw Error("Укажите название");
      const source = account
        ? latest.current.state.accounts
        : latest.current.state.categories;
      if (
        source.some(
          (x) =>
            !x.deleted &&
            x.id !== next.id &&
            x.name.trim().toLocaleLowerCase() ===
              next.name.toLocaleLowerCase() &&
            (account || x.kind === next.kind),
        )
      )
        throw Error("Такое название уже есть");
      if (account) next.opening = decimal(cents(next.opening));
      if (onPrepared) {
        await onPrepared(next);
        return;
      }
      await guard();
      await db.save(entity, next, scope.current);
      await refresh();
      if (onSaved) onSaved(next);
      else onClose();
      background();
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const archive = async () => {
    if (
      busy ||
      !confirm("Переместить в архив? Исторические операции сохранятся.")
    )
      return;
    setBusy(true);
    setError("");
    try {
      await guard();
      const original = (
        account
          ? latest.current.state.accounts
          : latest.current.state.categories
      ).find((x) => x.id === form.id);
      if (!original) throw Error("Запись больше не существует");
      const archived = { ...original, deleted: true };
      await db.save(entity, archived, scope.current);
      await refresh();
      if (onSaved) onSaved(archived);
      else onClose();
      background();
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const suggest = async () => {
    if (busy || !form.name.trim()) return;
    if (!navigator.onLine) {
      toast(
        "Для подбора через ИИ нужен интернет. Значок и цвет можно выбрать вручную.",
      );
      return;
    }
    if (!current.settings.connected) {
      toast("Сначала подключите синхронизацию в настройках");
      return;
    }
    const key = JSON.stringify([form.name.trim(), form.kind]),
      started = revision.current;
    if (variants.current.key !== key)
      variants.current = { key, list: [], previous: [], input: null };
    setBusy(true);
    setError("");
    try {
      await guard();
      if (!variants.current.list.length) {
        const v = variants.current;
        v.input ||= {
          id: crypto.randomUUID(),
          name: form.name.trim(),
          kind: form.kind,
          icons: allIcons.map((id) => ({ id, label: iconNames[id] || id })),
          colors: favoriteColors,
          categories: latest.current.state.categories
            .filter((c) => !c.deleted && c.id !== form.id)
            .map(({ name, kind, icon, color }) => ({
              name,
              kind,
              icon,
              color,
            })),
          exclude: v.previous,
        };
        const result = await api(
          `/api/books/${scope.current.bookId}/category-style`,
          v.input,
          undefined,
          scope.current.userId,
        );
        await guard();
        if (started !== revision.current) return;
        if (
          !Array.isArray(result.suggestions) ||
          result.suggestions.length !== 3 ||
          result.suggestions.some(
            (x) =>
              !allIcons.includes(x?.icon) || !favoriteColors.includes(x?.color),
          )
        )
          throw Error(
            "ИИ вернул недоступное оформление. Выберите вручную или повторите подбор",
          );
        v.list = result.suggestions.slice();
        v.previous = result.suggestions;
        v.input = null;
      }
      if (started === revision.current) {
        const choice = variants.current.list.shift();
        setForm((prev) => ({ ...prev, ...choice }));
      }
    } catch (e) {
      if (alive.current && started === revision.current) fail(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const displayed = allIcons.filter(
    (id, index) =>
      (query || group !== "popular" || index < 16 || id === form.icon) &&
      (!iconGroups.find((g) => g.id === group) ||
        iconGroups.find((g) => g.id === group).icons.includes(id)) &&
      `${iconNames[id] || ""} ${id}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const swatches = (values) =>
    values.map((color) => (
      <button
        key={color}
        type="button"
        className="color-choice"
        data-swatch={color}
        aria-label={`Цвет ${color}`}
        aria-pressed={color === form.color}
        style={{ backgroundColor: color }}
        onClick={() => set("color", color)}
      />
    ));
  return (
    <Dialog
      title={
        onPrepared
          ? "Оформление категории"
          : existing
            ? `Изменить ${account ? "счет" : "категорию"}`
            : account
              ? "Новый счет"
              : "Новая категория"
      }
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={save}>
        <label htmlFor="catalog-name">Название</label>
        <div className="row catalog-name">
          {!account && <ColoredIcon id="catalog-preview" category={form} />}
          <input
            id="catalog-name"
            name="name"
            value={form.name}
            maxLength="80"
            required
            onChange={(e) => set("name", e.target.value)}
          />
          {!account && (
            <button
              type="button"
              className="icon-button category-ai"
              aria-label="Подобрать значок и цвет с ИИ"
              aria-busy={busy}
              disabled={busy || !form.name.trim()}
              onClick={suggest}
            >
              <Icon name="spark" />
            </button>
          )}
        </div>
        {account ? (
          <>
            <label htmlFor="catalog-currency">Валюта счета</label>
            <select
              id="catalog-currency"
              value={currencyCode(form.currency)}
              disabled={existing}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  currency: e.target.value,
                  opening: "0.00",
                }))
              }
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <label htmlFor="catalog-opening">Начальный остаток</label>
            <input
              id="catalog-opening"
              name="opening"
              inputMode="decimal"
              value={form.opening}
              required
              onChange={(e) => set("opening", e.target.value)}
            />
          </>
        ) : (
          <>
            <input type="hidden" name="icon" value={form.icon} />
            <input type="hidden" name="color" value={form.color} />
            <label htmlFor="catalog-type">Тип</label>
            <select
              id="catalog-type"
              name="kind"
              disabled={existing || !!initialKind}
              value={form.kind}
              onChange={(e) => set("kind", e.target.value)}
            >
              <option value="expense">Расходы</option>
              <option value="income">Доходы</option>
            </select>
            <label htmlFor="icon-search">Значок</label>
            <input
              id="icon-search"
              aria-label="Поиск значка"
              type="search"
              placeholder="Например: кафе, транспорт, спорт"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
            />
            <label htmlFor="icon-group">Раздел значков</label>
            <select
              id="icon-group"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            >
              <option value="popular">Популярные</option>
              <option value="all">Все значки</option>
              {iconGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <div
              className="icon-picker"
              role="group"
              aria-label="Иконка категории"
            >
              {displayed.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="icon-choice"
                  data-icon={id}
                  aria-label={iconNames[id] || id}
                  title={iconNames[id] || id}
                  aria-pressed={id === form.icon}
                  onClick={() => set("icon", id)}
                >
                  <Icon name={id} />
                </button>
              ))}
            </div>
            {!displayed.length && (
              <p className="small" id="icon-empty">
                Значок не найден. Попробуйте другое название.
              </p>
            )}
            <button
              type="button"
              className="secondary full"
              data-action="more-icons"
              aria-expanded={group === "all"}
              onClick={() => setGroup(group === "all" ? "popular" : "all")}
            >
              {group === "all"
                ? "Основные значки"
                : `Все значки (${allIcons.length})`}
            </button>
            <label>Цвет</label>
            <div
              className="color-strip"
              role="group"
              aria-label="Цвет категории"
            >
              {swatches(favoriteColors)}
            </div>
            <details className="color-details">
              <summary>Больше цветов</summary>
              <p className="small">{palette.length} готовых оттенков</p>
              <div
                className="color-palette"
                role="group"
                aria-label="Палитра цветов"
              >
                {swatches(palette)}
              </div>
              <label>
                Свой цвет
                <input
                  type="color"
                  id="custom-color"
                  value={form.color}
                  onChange={(e) => set("color", e.target.value)}
                />
              </label>
            </details>
          </>
        )}
        <p className="form-error" role="alert">
          {error}
        </p>
        <div className="form-actions">
          {existing && !onPrepared && (
            <button
              type="button"
              className="danger"
              data-action="archive-catalog"
              disabled={busy}
              onClick={archive}
            >
              В архив
            </button>
          )}
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            Назад
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {onPrepared ? "Выбрать" : "Сохранить"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
