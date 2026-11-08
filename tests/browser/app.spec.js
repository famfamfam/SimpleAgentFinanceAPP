import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { clientAsset } from './helpers/client-assets.js';
import { resolve, extname } from "node:path";
const base = process.env.TEST_URL || "http://localhost:18080";
const registrationPassword = process.env.TEST_REGISTRATION_PASSWORD || "ci-only-registration-password";
async function ready(page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ваши финансы" }),
  ).toBeVisible();
  await page.waitForFunction(() => window.__financeReady);
}
async function add(page, note = "Проверка офлайн") {
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Сумма", exact: true })
    .fill("123,45");
  await page.getByRole("button", { name: "Продукты", exact: true }).click();
  await page.getByText("Комментарий и теги", {exact:true}).click();
  await page.getByLabel("Комментарий", { exact: true }).fill(note);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
}
async function state(page) {
  return page.evaluate(async () => {
    const db = await import("/db.js");
    return db.load();
  });
}
async function createConnected(context, page) {
  await ready(page);
  const registered = await context.request.post(base + "/api/register", {
    data: { nickname: "Browser test", password: registrationPassword },
  });
  expect(registered.ok()).toBeTruthy();
  const user = (await registered.json()).user;
  const local = await state(page);
  const book = local.settings.bookId;
  const created = await context.request.post(base + "/api/books", {
    data: { id: book, name: "Browser test" },
  });
  expect(created.ok()).toBeTruthy();
  await page.evaluate(
    async ({ book, user }) => {
      const db = await import("/db.js");
      await db.setMeta("settings", {
        ...(await db.meta("settings")),
        bookId: book,
        connected: true,
        userId: user.id,
      });
    },
    { book, user },
  );
  await page.reload();
  await page.waitForFunction(() => window.__financeReady);
  return book;
}

test("offline save survives closing and opening, with no horizontal overflow", async ({
  page,
  context,
}) => {
  // Stop the origin instead of WebKit's broken setOffline navigation emulation (playwright#42775).
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    try {
      if (path.includes("..") || path.startsWith("/api/")) throw Error();
      const file = path === "/" ? "index.html" : path.slice(1);
      const data = await clientAsset(file);
      res.setHeader(
        "Content-Type",
        {
          ".js": "text/javascript",
          ".css": "text/css",
          ".html": "text/html",
          ".png": "image/png",
          ".svg": "image/svg+xml",
          ".webmanifest": "application/manifest+json",
        }[extname(file)] || "application/octet-stream",
      );
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.__financeReady);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await add(page);
    expect((await state(page)).pending).toHaveLength(1);
    await expect(page.locator(".entry.just-added")).toContainText("123,45");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `test-results/offline-${test.info().project.name}.png`,
      fullPage: true,
    });
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(origin);
    await expect(
      reopened.getByRole("heading", { name: "Ваши финансы" }),
    ).toBeVisible();
    await reopened.getByRole("link", { name: "Операции", exact: true }).click();
    await expect(reopened.locator(".entry")).toContainText("Проверка офлайн");
    expect((await state(reopened)).pending).toHaveLength(1);
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
  }
});

test("editing and deleting an unsent entry leaves no duplicate operation", async ({
  page,
  context,
}) => {
  await ready(page);
  await context.setOffline(true);
  await add(page, "Первый текст");
  await page.locator(".entry").first().click();
  await page
    .getByLabel("Комментарий", { exact: true })
    .fill("Измененный текст");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  let data = await state(page);
  expect(data.pending).toHaveLength(1);
  expect(data.state.entries).toHaveLength(1);
  expect(data.state.entries[0].note).toBe("Измененный текст");
  await page.locator(".entry").first().click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Удалить операцию" }).click();
  await expect(page.locator(".entry")).toHaveCount(0);
  data = await state(page);
  expect(data.state.entries[0].deleted).toBeTruthy();
});

test("an account and a category can be created offline and used in an entry", async ({
  page,
  context,
}) => {
  await ready(page);
  await context.setOffline(true);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Добавить счет" }).click();
  await page.getByLabel("Название", { exact: true }).fill("Наличные");
  await page.locator("[name=opening]").fill("500");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByRole("button", { name: "Добавить категорию" }).click();
  await page.getByLabel("Название", { exact: true }).fill("Тестовая категория");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  expect((await state(page)).pending).toHaveLength(2);
});

test("local backup rejects damaged money before replacing existing data", async ({
  page,
}) => {
  await ready(page);
  await add(page);
  const result = await page.evaluate(async () => {
    const db = await import("/db.js");
    const backup = await db.backup();
    const entry = backup.outbox.find((x) => x.entity === "entry");
    entry.data.amount = "NaN";
    try {
      await db.restore(backup);
      return false;
    } catch {
      return (await db.load()).state.entries[0].amount === "123.45";
    }
  });
  expect(result).toBeTruthy();
});

test("ten thousand rows remain fast and render a limited list", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(async () => {
    const db = await import("/db.js");
    const { initialState, today } = await import("/model.js");
    const state = initialState();
    for (let i = 0; i < 10000; i++)
      state.entries.push({
        id: crypto.randomUUID(),
        kind: "expense",
        amount: "1.23",
        accountId: state.accounts[0].id,
        categoryId: state.categories[0].id,
        date: today(),
        note: "Тест " + i,
        tags: "",
        version: 2,
        deleted: false,
      });
    await db.accept({ state, revision: 2, results: [] });
  });
  await page.reload();
  await page.waitForFunction(() => window.__financeReady);
  const metrics = await page.evaluate(() => window.__financeReady);
  console.log(
    test.info().project.name,
    "10k local first screen",
    metrics.ms.toFixed(1),
    "ms",
  );
  expect(metrics.entries).toBe(10000);
  expect(metrics.ms).toBeLessThan(1500);
  await page.getByRole("link", { name: "Операции", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(100);
  await page
    .getByRole("searchbox", { name: "Поиск операций" })
    .fill("Тест 9999");
  await expect(page.locator(".entry")).toHaveCount(1);
  await page.screenshot({
    path: `test-results/ten-thousand-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("browser UI escapes financial comments", async ({ page }) => {
  await ready(page);
  await add(page, '<img src=x onerror="window.hacked=true">');
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
  await expect(page.locator(".entry-sub")).toContainText("<img");
});

test("connected book uploads a persisted offline change once", async ({
  page,
  context,
}) => {
  const book = await createConnected(context, page);
  await context.setOffline(true);
  await add(page, "Синхронизация");
  await context.setOffline(false);
  await expect
    .poll(async () => {
      const response = await context.request.get(
        base + `/api/books/${book}/sync`,
      );
      return (await response.json()).state.entries.length;
    })
    .toBe(1);
  await expect.poll(async () => (await state(page)).pending.length).toBe(0);
  await page
    .getByRole("button", { name: "Синхронизировать", exact: true })
    .click();
  const response = await context.request.get(base + `/api/books/${book}/sync`);
  expect((await response.json()).state.entries).toHaveLength(1);
});

test("unknown routes and bad origin do not expose authenticated API", async ({
  request,
}) => {
  expect((await request.get("/api/unknown")).status()).toBe(404);
  expect(
    (
      await request.post("/api/register", {
        headers: { Origin: "https://other.example" },
        data: { nickname: "x" },
      })
    ).status(),
  ).toBe(403);
});

test("registration waits for recovery key acknowledgement and the key restores the same user", async ({
  page,
  browser,
}) => {
  await ready(page);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page
    .getByRole("button", { name: "Подключить синхронизацию", exact: true })
    .click();
  await page
    .getByLabel("Как вас называть?", { exact: true })
    .fill("Проверка ключа");
  await page.getByLabel("Пароль доступа", { exact: true }).fill("incorrect-access-password");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page.locator(".form-error")).toContainText("Неверный пароль доступа");
  await page.getByLabel("Пароль доступа", { exact: true }).fill(registrationPassword);
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ключ восстановления", exact: true }),
  ).toBeVisible();
  const key = (await page.locator(".key-box").textContent()).trim();
  expect(key).toMatch(/^[\w-]{43}$/);
  expect((await state(page)).settings.connected).toBe(false);
  await page
    .getByRole("button", { name: "Я сохранил ключ", exact: true })
    .click();
  await expect
    .poll(async () => (await state(page)).settings.connected)
    .toBe(true);
  expect(await page.evaluate(async () => JSON.stringify(await (await import("/db.js")).backup()))).not.toContain(registrationPassword);
  const user = (await state(page)).settings.userId;
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
  });
  try {
    const second = await context.newPage();
    await second.goto(base);
    await second.waitForFunction(() => window.__financeReady);
    await second.getByRole("link", { name: "Настройки", exact: true }).click();
    await second
      .getByRole("button", { name: "Войти по личному ключу", exact: true })
      .click();
    await second.locator("[name=key]").fill(key);
    await second
      .getByRole("button", { name: "Продолжить", exact: true })
      .click();
    await expect
      .poll(async () => (await state(second)).settings.userId)
      .toBe(user);
    expect((await state(second)).settings.connected).toBe(true);
  } finally {
    await context.close();
  }
});

test("reference category palette persists and draws solid circular icons", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page
    .getByRole("button", { name: "Добавить категорию", exact: true })
    .click();
  await page.getByLabel("Название", { exact: true }).fill("Для кота");
  await page.getByRole("button", { name: "Животные", exact: true }).click();
  await page.getByText("Больше цветов", { exact: true }).click();
  await page
    .getByRole("group", { name: "Палитра цветов", exact: true })
    .getByRole("button", { name: "Цвет #ffaa65", exact: true })
    .click();
  await expect(page.locator("#catalog-preview")).toHaveCSS(
    "background-color",
    "rgb(255, 170, 101)",
  );
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.__financeReady);
  await page.getByRole("button", { name: "Категории", exact: true }).click();
  const row = page.locator(".setting-row").filter({ hasText: "Для кота" });
  const category = (await state(page)).state.categories.find(
    (x) => x.name === "Для кота",
  );
  expect(category.icon).toBe("paw");
  expect(category.color).toBe("#ffaa65");
  await expect(row.locator(".category-icon")).toHaveCSS(
    "background-color",
    "rgb(255, 170, 101)",
  );
  await expect(row.locator(".category-icon")).toHaveCSS("border-radius", "50%");
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("link", { name: "Обзор", exact: true }).click();
  await add(page, "Диаграмма");
  await page.getByRole("link", { name: "Обзор", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /Расходы по категориям:/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("inline category creation preserves the complete operation draft and supports editing time", async ({
  page,
  context,
}) => {
  await ready(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("button", { name: "Доход", exact: true }).click();
  await page.getByLabel("Сумма", { exact: true }).fill("123,45");
  await page
    .getByLabel("Дата", { exact: true })
    .fill(await page.evaluate(async () => (await import("/model.js")).today()));
  await page.getByLabel("Время", { exact: true }).fill("17:45");
  await page.getByText("Комментарий и теги", { exact: true }).click();
  await page.getByLabel("Комментарий", { exact: true }).fill("За проект");
  await page.getByLabel("Теги", { exact: true }).fill("работа");
  await page
    .getByRole("button", { name: "Новая категория", exact: true })
    .click();
  await expect(page.locator("[name=kind]")).toHaveValue("income");
  await expect(page.locator("[name=kind]")).toBeDisabled();
  await page.getByLabel("Название", { exact: true }).fill("Подработка");
  await page.getByLabel("Поиск значка", { exact: true }).fill("работа");
  await page.getByLabel("Поиск значка", { exact: true }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "Новая категория", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Работа", exact: true }).click();
  await page
    .getByRole("group", { name: "Цвет категории", exact: true })
    .getByRole("button", { name: "Цвет #435ac2", exact: true })
    .click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Новая операция", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Сумма", { exact: true })).toHaveValue("123,45");
  await expect(page.getByLabel("Время", { exact: true })).toHaveValue("17:45");
  await expect(page.getByLabel("Комментарий", { exact: true })).toHaveValue(
    "За проект",
  );
  await expect(
    page.getByRole("button", { name: "Подработка", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  let local = await state(page);
  expect(local.state.entries).toHaveLength(1);
  expect(local.state.entries[0]).toMatchObject({
    kind: "income",
    amount: "123.45",
    time: "17:45",
    note: "За проект",
    tags: "работа",
  });
  expect(
    local.state.categories.find((x) => x.name === "Подработка"),
  ).toMatchObject({ kind: "income", icon: "briefcase", color: "#435ac2" });
  await page.locator(".entry").first().click();
  await expect(
    page.getByRole("heading", { name: "Изменить операцию", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Время", { exact: true }).fill("00:00");
  await page.getByLabel("Сумма", { exact: true }).fill("200");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  local = await state(page);
  expect(local.state.entries).toHaveLength(1);
  expect(local.state.entries[0]).toMatchObject({
    time: "00:00",
    amount: "200.00",
  });
  await expect(page.locator(".entry time")).toHaveText("00:00");
});

test("opening an entry never steals focus back from a selected field", async ({ page }) => {
  await ready(page);
  await page.getByRole('button', {name:'Добавить',exact:true}).click();
  await expect(page.locator('#entry-time')).toBeVisible();
  const focused = await page.evaluate(async () => {
    const time = document.querySelector("#entry-time");
    time.focus();
    window.dispatchEvent(new Event('finance-updated'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return document.activeElement === time;
  });
  expect(focused).toBe(true);
});

test("canceling a nested category and expanding categories never loses the amount", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByLabel("Сумма", { exact: true }).fill("999");
  await page.getByLabel("Время", { exact: true }).fill("09:15");
  await page.getByRole("button", { name: /Все категории/ }).click();
  await page.getByLabel("Поиск категории", { exact: true }).fill("Животина");
  await page.getByLabel("Поиск категории", { exact: true }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "Новая операция", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Животина", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая категория", exact: true })
    .click();
  await page.getByLabel("Название", { exact: true }).fill("Не сохранять");
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.getByLabel("Сумма", { exact: true })).toHaveValue("999");
  await expect(page.getByLabel("Время", { exact: true })).toHaveValue("09:15");
  await expect(
    page.getByRole("button", { name: "Животина", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "Новая категория", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Сумма", { exact: true })).toHaveValue("999");
  expect((await state(page)).pending).toHaveLength(0);
  await page
    .getByRole("button", { name: "Свернуть категории", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Животина", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.querySelector("dialog").scrollWidth <=
        document.querySelector("dialog").clientWidth,
    ),
  ).toBeTruthy();
});

async function importWorkbook(page, bytes, name = "sample.xlsx") {
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Импортировать XLSX", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: bytes,
  });
}

test("local XLSX import and export need no account and preserve midnight without duplicate imports", async ({
  page,
  context,
}) => {
  await ready(page);
  const local = await state(page);
  const entry = {
    id: randomUUID(),
    kind: "expense",
    amount: "12.34",
    date: "2026-10-29",
    time: "00:00",
    accountId: local.state.accounts[0].id,
    categoryId: local.state.categories[0].id,
    note: "Из файла",
    tags: "",
    deleted: false,
    version: 0,
  };
  const file = await context.request.post(base + "/api/local-files/export", {
    data: { ...local.state, entries: [entry] },
  });
  expect(file.ok()).toBeTruthy();
  const bytes = await file.body();
  let registrations = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/register")) registrations++;
  });
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await importWorkbook(page, bytes);
  await expect(
    page.getByRole("heading", { name: "Проверка импорта", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Импортировать", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Операции", exact: true })).toBeVisible();
  await expect(page.locator(".entry")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Выбрать период", exact: true })).toHaveText("Всё время");
  expect((await state(page)).state.entries[0]).toMatchObject({
    time: "00:00",
    amount: "12.34",
  });
  expect((await state(page)).settings.connected).toBe(false);
  await importWorkbook(page, bytes);
  await expect(page.locator("#toast")).toHaveText("Этот файл уже импортирован");
  expect((await state(page)).state.entries).toHaveLength(1);
  const exported = page.waitForResponse((r) =>
    r.url().endsWith("/api/local-files/export"),
  );
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page
    .getByRole("button", { name: "Выгрузить XLSX", exact: true })
    .click();
  expect((await exported).ok()).toBeTruthy();
  const doubleFile = await context.request.post(
    base + "/api/local-files/export",
    {
      data: {
        ...local.state,
        entries: [entry, { ...entry, id: randomUUID() }],
      },
    },
  );
  await importWorkbook(page, await doubleFile.body(), "double.xlsx");
  await expect(
    page.getByRole("checkbox", { name: /Возможный повтор/ }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Импортировать", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect((await state(page)).state.entries).toHaveLength(2);
  expect(registrations).toBe(0);
});

test("local XLSX refuses to apply a preview after the book changes", async ({
  page,
  context,
}) => {
  await ready(page);
  const local = await state(page);
  const file = await context.request.post(base + "/api/local-files/export", {
    data: {
      ...local.state,
      entries: [
        {
          id: randomUUID(),
          kind: "expense",
          amount: "1.00",
          date: "2026-10-29",
          accountId: local.state.accounts[0].id,
          categoryId: local.state.categories[0].id,
          note: "",
          tags: "",
          deleted: false,
          version: 0,
        },
      ],
    },
  });
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await importWorkbook(page, await file.body());
  await expect(
    page.getByRole("heading", { name: "Проверка импорта", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const db = await import("/db.js");
    const local = await db.load();
    await db.save(
      "account",
      { ...local.state.accounts[0], opening: "500.00" },
      local.settings.bookId,
    );
  });
  await page
    .getByRole("button", { name: "Импортировать", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Учет изменился после предпросмотра",
  );
  expect((await state(page)).state.entries).toHaveLength(0);
});

test("same-day history follows operation time even after editing an older row", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(async () => {
    const db = await import("/db.js"),
      model = await import("/model.js"),
      local = await db.load();
    const entry = {
      kind: "expense",
      amount: "1.00",
      date: model.today(),
      accountId: local.state.accounts[0].id,
      categoryId: local.state.categories[0].id,
      tags: "",
      version: 0,
      deleted: false,
    };
    await db.saveMany(
      [
        {
          entity: "entry",
          data: {
            ...entry,
            id: crypto.randomUUID(),
            time: "08:00",
            note: "Утро",
          },
        },
        {
          entity: "entry",
          data: {
            ...entry,
            id: crypto.randomUUID(),
            time: "19:00",
            note: "Вечер",
          },
        },
      ],
      local.settings.bookId,
    );
    window.dispatchEvent(new Event("finance-updated"));
  });
  await page.getByRole("link", { name: "Операции", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(2);
  await expect(page.locator(".entry").first()).toContainText("Вечер");
  await page.locator(".entry").filter({ hasText: "Утро" }).click();
  await page.getByLabel("Комментарий", { exact: true }).fill("Утро изменено");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".entry").first()).toContainText("Вечер");
});

test("prepared transfers show both accounts and editable time before saving", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(async () => {
    const db = await import("/db.js"),
      model = await import("/model.js"),
      local = await db.load(),
      second = {
        id: crypto.randomUUID(),
        name: "Второй счет",
        opening: "0.00",
        version: 0,
        deleted: false,
      };
    await db.save("account", second, local.settings.bookId);
    await db.setMeta("ai-results", [
      {
        id: crypto.randomUUID(),
        bookId: local.settings.bookId,
        saved: false,
        result: {
          text: "Перевод",
          receipt: false,
          entries: [
            {
              id: crypto.randomUUID(),
              kind: "transfer",
              amount: "100.00",
              accountId: local.state.accounts[0].id,
              toAccountId: second.id,
              date: model.today(),
              time: "14:30",
              note: "Перевод",
              tags: "",
              version: 0,
              deleted: false,
            },
          ],
        },
      },
    ]);
  });
  await page.goto("/#assistant");
  await page.reload();
  await page.getByRole("button", { name: /Прежняя переписка/ }).click();
  await page
    .getByRole("button", { name: "Проверить и сохранить", exact: true })
    .click();
  await expect(page.getByLabel("Откуда", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Куда", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Время", { exact: true })).toHaveValue("14:30");
  await page.getByLabel("Время", { exact: true }).fill("15:45");
  await page
    .getByRole("button", { name: "Сохранить (1)", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect((await state(page)).state.entries[0]).toMatchObject({
    kind: "transfer",
    time: "15:45",
    amount: "100.00",
  });
});

test("a second account can be added from a transfer without losing its draft", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("button", { name: "Перевод", exact: true }).click();
  await page.getByLabel("Сумма", { exact: true }).fill("500");
  await page.getByLabel("Время", { exact: true }).fill("18:20");
  await page.getByRole("button", { name: "Новый счет получателя", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Копилка");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByLabel("Сумма", { exact: true })).toHaveValue("500");
  await expect(page.getByLabel("Время", { exact: true })).toHaveValue("18:20");
  const accounts = (await state(page)).state.accounts;
  const from = accounts.find((x) => x.name === "Копилка"),
    to = accounts.find((x) => x.name === "Основной");
  await expect(page.getByLabel("Куда", { exact: true })).toHaveValue(from.id);
  await page.getByLabel("Откуда", { exact: true }).selectOption(from.id);
  await page.getByLabel("Куда", { exact: true }).selectOption(to.id);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  const local = await state(page);
  expect(local.state.entries[0]).toMatchObject({
    kind: "transfer",
    time: "18:20",
    amount: "500.00",
    accountId: from.id,
    toAccountId: to.id,
  });
});


test("grouped category icons filter by section and persist a new icon", async ({ page }) => {
  await ready(page);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Добавить категорию", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Поездки на метро");
  await page.getByLabel("Раздел значков", { exact: true }).selectOption("transport");
  await expect(page.locator(".icon-choice:visible")).toHaveCount(16);
  await expect(page.getByRole("button", { name: "Фрукты", exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Метро", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator('#modal')).not.toBeVisible();
  expect((await state(page)).state.categories.find(c => c.name === "Поездки на метро").icon).toBe("subway");
  await page.getByRole("button", { name: "Добавить категорию", exact: true }).click();
  await page.getByLabel("Поиск значка").fill("стоматология");
  await expect(page.locator(".icon-choice:visible")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Стоматология", exact: true })).toBeVisible();
});

test("quick assistant keeps the manual draft across return and restart without sending it", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  const helper = page.getByRole("button", { name: "Добавить через помощника", exact: true });
  const bounds = await helper.boundingBox(), amount = await page.getByLabel("Сумма", { exact: true }).boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.x).toBeGreaterThanOrEqual(amount.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(amount.x + amount.width);
  expect(bounds.y).toBeGreaterThanOrEqual(amount.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(amount.y + amount.height);
  await expect(helper).toHaveText("");
  await page.getByRole("button", { name: "Добавить через помощника", exact: true }).click();
  await expect(page.locator("#ai-text")).toHaveValue("");
  await page.getByRole("button", { name: "Назад к операции", exact: true }).click();
  await page.getByLabel("Сумма", { exact: true }).fill("500");
  await page.getByLabel("Дата", { exact: true }).fill("2026-10-20");
  await page.getByLabel("Время", { exact: true }).fill("08:15");
  await page.getByText("Комментарий и теги", {exact:true}).click();
  await page.getByLabel("Комментарий", { exact: true }).fill("Кофе");
  await page.getByRole("button", { name: "Добавить через помощника", exact: true }).click();
  await expect(page.locator("#ai-text")).toHaveValue("Расход 500 ₽ Кофе");
  await expect(page.locator("#ai-text")).toBeFocused();
  expect((await page.evaluate(async () => (await import("/db.js")).meta("ai-queue"))) || []).toHaveLength(0);
  await page.getByRole("button", { name: "Назад к операции", exact: true }).click();
  await expect(page.getByLabel("Дата", { exact: true })).toHaveValue("2026-10-20");
  await expect(page.getByLabel("Время", { exact: true })).toHaveValue("08:15");
  await page.getByLabel("Сумма", { exact: true }).fill("501");
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Назад к операции", exact: true }).click();
  await expect(page.getByLabel("Сумма", { exact: true })).toHaveValue("501");
  await expect(page.getByLabel("Комментарий", { exact: true })).toHaveValue("Кофе");
  await page.getByRole("button", { name: "Кафе", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("#modal")).not.toBeVisible();
  expect((await state(page)).state.entries).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Назад к операции", exact: true })).not.toBeVisible();
});
