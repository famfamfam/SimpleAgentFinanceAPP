import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const svg = await readFile(new URL("../backend/web/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
try {
  for (const size of [180, 192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.screenshot({ path: `backend/web/icon-${size}.png` });
    await page.close();
  }
} finally {
  await browser.close();
}
