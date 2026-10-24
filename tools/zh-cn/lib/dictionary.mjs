/**
 * The one place that decides which dictionary a run uses, and what wins.
 *
 *   const dictionary = loadDictionary(root);
 *
 * Resolution order:
 *   1. `.zh-cn/dictionary.json`   working dictionary (translate.mjs wrote it, or
 *      the `zh-cn-state` branch restored it). Present only when a translation
 *      run happened, so it is shadowed by nothing but reflects the newest model
 *      output.
 *   2. `tools/zh-cn/seed.zh-cn.json`  committed snapshot. Used by every build
 *      that never ran translate.mjs (first run, no credentials, fresh clone) —
 *      without it the app would ship all-English.
 *   3. `tools/zh-cn/overrides.json`  hand-fixed translations, applied **on top
 *      of** whichever file won. Applying them at load time (not only inside
 *      translate.mjs) is what makes a hand edit work when the translate step is
 *      skipped, and keeps the webview layer and the native menu reading the
 *      same dictionary.
 */
import fs from "node:fs";
import path from "node:path";

const CANDIDATES = [".zh-cn/dictionary.json", "tools/zh-cn/seed.zh-cn.json"];
const OVERRIDES = ["tools", "zh-cn", "overrides.json"];

/** Hand-fixed translations. The `_comment` key is documentation, not a string. */
export function loadOverrides(root) {
  const file = path.join(root, ...OVERRIDES);
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  delete parsed._comment;
  return parsed;
}

/**
 * Writes one translation into the table it belongs to: template strings (any
 * `{n}` slot) go to `patterns`, everything else to `entries`. A hand-fixed
 * string also leaves the keep-English list — the human just asked for it.
 */
export function store(dictionary, source, translated) {
  if (/\{\d+\}/.test(source)) dictionary.patterns[source] = translated;
  else dictionary.entries[source] = translated;
  if (dictionary.kept[source] === 1) dictionary.kept[source] = 0;
  delete dictionary.untranslated?.[source];
}

export function loadDictionary(root) {
  const file = CANDIDATES.map((rel) => path.join(root, rel)).find((candidate) => fs.existsSync(candidate));
  const parsed = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const dictionary = {
    entries: parsed.entries ?? {},
    patterns: parsed.patterns ?? {},
    kept: parsed.kept ?? {},
    menu: parsed.menu ?? { byId: {}, byText: {} },
    source: file ? path.relative(root, file) : null,
  };
  for (const [source, translated] of Object.entries(loadOverrides(root))) {
    if (typeof translated === "string" && translated.trim()) store(dictionary, source, translated);
  }
  return dictionary;
}

/**
 * Strings that must stay English (brand names, protocol constants) are dropped
 * before injection: the native menu and the webview layer both use this, so a
 * kept string cannot come back to life on one side only. Entries that render as
 * themselves are noise the runtime script would carry for nothing.
 */
export function dropKept(table, kept = {}) {
  const out = {};
  for (const [source, target] of Object.entries(table ?? {})) {
    if (kept[source] === 1) continue;
    if (typeof target !== "string" || !target.trim() || target === source) continue;
    out[source] = target;
  }
  return out;
}