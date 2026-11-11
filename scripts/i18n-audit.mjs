import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import english from "../backend/web/en.js";

// Exact exceptions, not whole UI files: these are persisted history or template fragments.
const exceptions = new Map([
  ["Фото чека · ", "media label; rendered with a named filename parameter"],
  ["Голосовой запрос", "legacy assistant context; do not rewrite persisted requests"],
  ["Проверьте перед сохранением: ", "persisted conversation text; not a UI label"],
]);
const cyrillic = /[А-Яа-яЁё]/u;
const params = text => [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]))].sort().join(",");

// shortcut: lexical inventory, not a JSX parser; inspect --dynamic and the full inventory before release.
export function missingLiterals(text, dictionary = english) {
  return [...text.matchAll(/"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/g)].flatMap(match => {
    let source;
    try { source = match[0][0] === '"' ? JSON.parse(match[0]) : match[0].slice(1, -1).replace(/\\'/g, "'"); } catch { return []; }
    if (!cyrillic.test(source) || exceptions.has(source) || Object.hasOwn(dictionary, source)) return [];
    return [{ source, line: text.slice(0, match.index).split("\n").length }];
  });
}

async function main() {
  const check = process.argv.includes("--check"), dynamic = process.argv.includes("--dynamic");
  const files = new Set();
  async function collect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === "backend" && entry.name !== "web") continue;
        await collect(path);
      } else if ([".js", ".jsx", ".go"].includes(extname(path)) && !entry.name.endsWith("_test.go") && !/^en(?:-.+)?\.js$/.test(entry.name)) files.add(path);
    }
  }
  for (const root of ["frontend/src", "backend"]) await collect(root);
  let missing = 0, mismatched = 0;
  for (const file of [...files].sort()) {
    const text = await readFile(file, "utf8"), path = relative(".", file);
    if (!check && !dynamic) text.split(/\r?\n/).forEach((line, i) => {
      if (cyrillic.test(line)) console.log(`${path}:${i + 1}: ${line.trim()}`);
    });
    if (dynamic) for (const match of text.matchAll(/\bt\(\s*(?!["'\s])/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      console.log(`${path}:${line}: ${text.split("\n")[line - 1].trim()}`);
    }
    // Includes literal branches, menu arrays, errors and icon names, not just t("...").
    // Go prompts/file formats and the standalone benchmark are inventory-only.
    if (check && [".js", ".jsx"].includes(extname(file)) && !file.endsWith("benchmark.js")) {
      for (const issue of missingLiterals(text)) {
        console.error(`Missing translation: ${path}:${issue.line}: ${issue.source}`);
        missing++;
      }
    }
  }
  if (check) {
    for (const [source, translated] of Object.entries(english)) if (params(source) !== params(translated)) {
      console.error(`Parameter mismatch: ${source}`);
      mismatched++;
    }
    console.log(`i18n: ${missing} missing literals, ${mismatched} parameter mismatches; review --dynamic and the full inventory separately`);
    if (missing || mismatched) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
