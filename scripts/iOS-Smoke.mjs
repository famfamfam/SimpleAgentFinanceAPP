import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { join } from "node:path";

const config = await readFile(".env", "utf8");
const host = config.match(/^APP_HOST=(.+)$/m)?.[1].trim();
assert(host, "APP_HOST is required");
const origin = `https://${host}:18443`;
const standalone = process.argv.includes("--standalone");
const tag = standalone ? "ios-pwa" : "ios-safari";
const iosPython =
  process.env.IOS_PYTHON ||
  join(
    "tmp",
    "ios-tools",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
const devices = JSON.parse(
  execFileSync(
    iosPython,
    ["-m", "pymobiledevice3", "usbmux", "list", "--usb"],
    { encoding: "utf8", timeout: 15000 },
  ),
);
assert.equal(devices.length, 1, "Connect one iPhone for this test.");
const device = devices[0];
const browser = await chromium.connectOverCDP("http://127.0.0.1:19222", {
  timeout: 60000,
});
let stopped = false;
const compose = (...args) =>
  execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    timeout: 30000,
  });
const ready = async (page) => {
  await page.waitForFunction(() => Boolean(window.__financeReady), null, {
    timeout: 30000,
  });
  return page.evaluate(() => ({
    ready: window.__financeReady,
    timeOrigin: performance.timeOrigin,
    secure: isSecureContext,
    controller: navigator.serviceWorker.controller?.state,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
};
const fingerprint = (page) =>
  page.evaluate(async () => {
    const db = await import("/db.js"),
      data = await db.load();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(data.state)),
    );
    return {
      bookId: data.settings.bookId,
      entries: data.state.entries.length,
      hash: Array.from(new Uint8Array(digest), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join(""),
    };
  });
try {
  const context = browser.contexts()[0];
  let page;
  for (const candidate of context
    .pages()
    .filter((p) => p.url().startsWith(origin + "/") || p.url() === origin)) {
    if (
      (await candidate.evaluate(
        () => matchMedia("(display-mode: standalone)").matches,
      )) === standalone
    ) {
      page = candidate;
      break;
    }
  }
  assert(
    page,
    standalone
      ? "Open Финансы from the Home Screen first."
      : "Open the finance application in Safari first.",
  );
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    "Close any unsaved form before testing",
  );
  await page.goto(origin, { waitUntil: "commit", timeout: 30000 });
  await ready(page);
  const before = await fingerprint(page);
  console.log(`${tag} connected; financial state fingerprint recorded.`);
  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    standalone: matchMedia("(display-mode: standalone)").matches,
  }));
  const first = await ready(page);
  assert(first.secure && first.controller === "activated" && !first.overflow);
  const navigation = [];
  for (let i = 0; i < 5; i++) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    const state = await ready(page);
    assert(!state.overflow);
    navigation.push(state.ready.ms);
  }
  console.log("Navigation timings:", JSON.stringify(navigation));
  await mkdir("tmp", { recursive: true });
  // shortcut: inspector screenshots stall on iOS 26.3; use on-device captures for visual checks.
  const health = await page.evaluate(
    async () =>
      (
        await fetch("/api/health", {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        })
      ).ok,
  );
  assert(health, "The server must be reachable before the offline check");
  const previous = (await ready(page)).timeOrigin;
  console.log("Stopping only the local HTTPS container for the cache check.");
  try {
    stopped = true;
    compose("stop", "https");
    const unreachable = await page.evaluate(async () => {
      try {
        await fetch("/api/health", {
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
        });
        return false;
      } catch {
        return true;
      }
    });
    assert(unreachable, "The origin must really be unreachable");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    const offline = await ready(page);
    assert(
      offline.timeOrigin > previous,
      "The offline check must load a new document",
    );
    assert(offline.controller === "activated" && !offline.overflow);
    await writeFile(
      `tmp/${tag}-offline-metrics.json`,
      JSON.stringify({ serverUnreachable: unreachable, ...offline }, null, 2),
    );
    console.log("Offline document loaded:", JSON.stringify(offline));
  } finally {
    compose("start", "https");
    stopped = false;
  }
  let restored = false;
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://${host}:18081/ca.crt`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        restored = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(restored, "The local HTTPS server must restart after the cache check");
  await page.goto(origin + "/benchmark.html", {
    waitUntil: "commit",
    timeout: 30000,
  });
  await page.waitForFunction(
    () =>
      location.pathname === "/benchmark.html" &&
      document.readyState === "complete" &&
      Boolean(document.getElementById("run")),
    null,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const button = document.getElementById("run");
    if (!button) throw Error("Benchmark button missing");
    button.click();
  });
  await page.waitForFunction(() => Boolean(window.__benchmark), null, {
    timeout: 120000,
  });
  const benchmark = await page.evaluate(() => window.__benchmark);
  assert.equal(benchmark.count, 10000);
  console.log("Benchmark timings:", JSON.stringify(benchmark.samples));

  await page.goto(origin, { waitUntil: "commit", timeout: 30000 });
  await ready(page);
  assert.deepEqual(
    await fingerprint(page),
    before,
    "The personal financial book must not change",
  );
  const offline = JSON.parse(
    await readFile(`tmp/${tag}-offline-metrics.json`, "utf8"),
  );
  const metrics = {
    date: new Date().toISOString(),
    device: device.ProductType,
    os: device.ProductVersion,
    environment,
    navigationMs: navigation,
    offline,
    tenThousand: benchmark,
    personalBookUnchanged: true,
    note: "Navigation-to-UI timings exclude the OS launcher and Safari process startup. Offline check stops the local HTTPS origin; it does not switch the whole device into airplane mode. Benchmark uses a separate database.",
  };
  await writeFile(`tmp/${tag}-metrics.json`, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
} finally {
  if (stopped) compose("start", "https");
  await browser.close();
}
