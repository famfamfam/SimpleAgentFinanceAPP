import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const adb =
  process.env.ADB ||
  (process.platform === "win32"
    ? join(
        process.env.LOCALAPPDATA,
        "Android",
        "Sdk",
        "platform-tools",
        "adb.exe",
      )
    : "adb");
const run = (...args) => execFileSync(adb, args, { encoding: "utf8" }).trim();
run("reverse", "tcp:18080", "tcp:18080");
run(
  "shell",
  "am",
  "start",
  "-a",
  "android.intent.action.VIEW",
  "-d",
  "http://localhost:18080",
  "com.android.chrome",
);
const port = run("forward", "tcp:0", "localabstract:chrome_devtools_remote");
if (!/^\d+$/.test(port)) throw Error("Unexpected ADB port");
await mkdir("tmp", { recursive: true });
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0],
    page =
      context
        .pages()
        .find((p) => p.url().startsWith("http://localhost:18080")) ||
      (await context.newPage());
  await page.bringToFront();
  await page.goto("http://localhost:18080");
  await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
    if (registration.installing) {
      const worker = registration.installing;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.removeEventListener("statechange", changed);
          reject(Error("Service Worker install timed out"));
        }, 15000);
        const changed = () => {
          if (["installed", "activated", "redundant"].includes(worker.state)) {
            clearTimeout(timer);
            worker.removeEventListener("statechange", changed);
            resolve();
          }
        };
        worker.addEventListener("statechange", changed);
        changed(); // Installation can finish before the listener is attached.
      });
    }
    if (registration.waiting) {
      const changed = new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
      registration.waiting.postMessage("ACTIVATE_UPDATE");
      await Promise.race([
        changed,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Error("Service Worker activation timed out")),
            15000,
          ),
        ),
      ]);
    }
  });
  await page.reload();
  await page.waitForFunction(
    () => navigator.serviceWorker.controller && window.__financeReady,
  );
  const online = [];
  for (let i = 0; i < 5; i++) {
    await page.reload();
    await page.waitForFunction(() => window.__financeReady);
    online.push((await page.evaluate(() => window.__financeReady)).ms);
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  let offline;
  try {
    await page.reload();
    await page.waitForFunction(() => window.__financeReady);
    offline = await page.evaluate(() => window.__financeReady);
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }
  await page.screenshot({ path: "tmp/android-mvp.png" });
  await page.goto("http://localhost:18080/benchmark.html");
  await page.getByRole("button", { name: "Запустить проверку" }).click();
  await page.waitForFunction(() => window.__benchmark, { timeout: 120000 });
  const benchmark = await page.evaluate(() => window.__benchmark);
  await page.screenshot({ path: "tmp/android-benchmark.png" });
  const metrics = {
    device: run("shell", "getprop", "ro.product.model"),
    android: run("shell", "getprop", "ro.build.version.release"),
    onlineNavigationMs: online,
    offlineNavigation: offline,
    tenThousand: benchmark,
    note: "Navigation-to-UI time; excludes the OS launcher and Chrome process startup. Benchmark uses a separate database.",
  };
  await writeFile("tmp/android-metrics.json", JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
  await page.goto("http://localhost:18080");
} finally {
  if (browser) await browser.close();
  run("forward", "--remove", `tcp:${port}`);
}
