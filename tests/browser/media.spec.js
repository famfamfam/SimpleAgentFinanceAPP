import {fakeRecorder} from "./helpers/voice.js";
async function localAssistant(page) {
  await page.goto("/#assistant");await page.waitForFunction(()=>window.__financeReady);
  await page.evaluate(async()=>{const db=await import('/db.js');await db.setMeta('settings',{...await db.meta('settings'),userId:'00000000-0000-4000-8000-000000000999',connected:false});});
  await page.reload();await page.waitForFunction(()=>window.__financeReady);
}
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test.use({ serviceWorkers: "block" });

test("sending waits for image processing and then queues the attachment", async ({ page }) => {
  await localAssistant(page);
  await page.evaluate(() => {
    const decode = window.createImageBitmap;
    window.createImageBitmap = async file => {
      await new Promise(resolve => window.finishImage = resolve);
      return decode(file);
    };
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Приложить фото чека", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать файл", exact: true }).click();
  await (await chooser).setFiles({ name: "test-receipt.png", mimeType: "image/png", buffer: await readFile("backend/web/icon-192.png") });
  await page.locator("#ai-text").fill("Разобрать чек");
  await page.getByRole("button", { name: /Отправить/ }).click();
  await expect(page.locator("#toast")).toContainText("Дождитесь обработки");
  expect(await page.evaluate(async () => (await (await import("/db.js")).meta("ai-queue")) || [])).toEqual([]);
  await page.evaluate(() => window.finishImage());
  await expect(page.locator("#ai-attachment")).toContainText("Фото чека");
  await page.getByRole("button", { name: /Отправить/ }).click();
  await expect.poll(() => page.evaluate(async () => ((await (await import("/db.js")).meta("ai-queue")) || []).length)).toBe(1);
  expect(await page.evaluate(async () => (await (await import("/db.js")).meta("ai-queue"))[0].input.image)).toMatch(/^data:image\/jpeg;base64,/);
});

test("gallery offers a file picker and a camera with a rear-camera hint",async({page})=>{
  await localAssistant(page);
  for(const camera of [true,false]) {
    await page.getByRole("button",{name:"Приложить фото чека",exact:true}).click();
    await expect(page.getByRole("button",{name:"Выбрать файл",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Сделать фото",exact:true})).toBeVisible();
    const chooser=page.waitForEvent("filechooser");
    await page.getByRole("button",{name:camera?"Сделать фото":"Выбрать файл",exact:true}).click();
    const file=await chooser;
    expect(await file.element().getAttribute("capture")).toBe(camera?"environment":null);
    expect(await file.element().getAttribute("accept")).toBe("image/*");
    await file.setFiles([]);
  }
});

test("leaving the assistant stops recording and releases microphone tracks", async ({ page }) => {
  await localAssistant(page);
  await fakeRecorder(page);
  await page.getByRole("button", { name: "Записать голос", exact: true }).click();
  await expect(page.locator("#ai-attachment")).toContainText("Идёт запись");
  await page.getByRole("link", { name: "Обзор", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.trackReleased)).toBe(true);
  expect(await page.evaluate(() => window.testRecorder.state)).toBe("inactive");
});

test("a recorder start failure releases the microphone", async ({ page }) => {
  await localAssistant(page);
  await page.evaluate(() => {
    if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop: () => window.trackReleased = true }] });
    window.MediaRecorder = class { start() { throw new DOMException("Codec unavailable", "NotSupportedError"); } };
  });
  await page.getByRole("button", { name: "Записать голос", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Не удалось начать запись");
  expect(await page.evaluate(() => window.trackReleased)).toBe(true);
  await page.locator("#ai-text").fill("Кофе 250");
  await page.getByRole("button", { name: /Отправить/ }).click();
  await expect.poll(() => page.evaluate(async () => ((await (await import("/db.js")).meta("ai-queue")) || []).length)).toBe(1);
});

test("voice can be previewed, cancelled and kept in the sent message",async({page,browserName})=>{
  await localAssistant(page);
  await fakeRecorder(page);
  await page.getByRole("button",{name:"Записать голос",exact:true}).click();
  await expect(page.locator(".ai-tools .record-stop")).toHaveCount(1);
  await expect(page.getByRole("button",{name:"Записать голос",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Отменить запись",exact:true}).click();
  await expect(page.locator("audio")).toHaveCount(0);
  expect(await page.evaluate(()=>window.trackReleased)).toBe(true);
  await page.getByRole("button",{name:"Записать голос",exact:true}).click();
  await page.getByRole("button",{name:"Остановить запись",exact:true}).click();
  await expect(page.locator("#ai-attachment audio")).toBeVisible();
  await expect(page.locator("#ai-attachment")).toContainText("1 сек.");
  // The Windows WebKit test build has no WAV playback codec; the real device covers playback.
  if (browserName !== "webkit") await page.locator("audio").evaluate(el=>el.play());
  await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await page.getByRole("button",{name:"Прослушать голосовое сообщение",exact:true}).click();
  await expect(page.locator(".chat-user audio")).toBeVisible();
  await expect(page.locator(".ai-queued")).toContainText("В очереди");
  await page.reload();await page.getByRole("button",{name:"Прослушать голосовое сообщение",exact:true}).click();await expect(page.locator(".chat-user audio")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
