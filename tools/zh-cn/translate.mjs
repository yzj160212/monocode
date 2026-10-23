#!/usr/bin/env node
/**
 * Translates the work list into Simplified Chinese and maintains the
 * incremental dictionary at .zh-cn/dictionary.json.
 *
 *   node tools/zh-cn/translate.mjs [--root .] [--workers 6] [--limit N] [--strict]
 *
 * The dictionary is keyed by English source text, so a rerun after an upstream
 * update only pays for strings that are actually new. Credentials come from
 * ZH_TRANSLATE_* (see lib/provider.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete, parseJsonObject, resolveProvider } from "./lib/provider.mjs";
import { KEEP } from "./lib/filters.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DICT_FILE = ".zh-cn/dictionary.json";
const WORKLIST_FILE = ".zh-cn/worklist.json";

const SYSTEM = `你是资深 macOS 桌面软件本地化译者，把英文 UI 文案译成简体中文。

规则：
1. 只输出 JSON 对象，键与输入的英文完全一致，值为译文。不要解释、不要 markdown 围栏。
2. 译文简洁，符合中文软件界面习惯：按钮/菜单用动词短语（"Save Changes" -> "保存更改"），名词短语保持短（"No project folder" -> "无项目文件夹"）。
3. 占位符（{0}、{1}、%s、%d、{{name}}、\\n、↩、⌘）原样保留，顺序可随中文语序调整。
   例外：如果某个占位符只承载英文单复数（例如数量 + 单复数词 + "available." 这种写法里的第二个占位符），
   中文不区分单复数，必须省略它，只保留数量占位符。
4. 品牌与产品名不翻译：MonoCode、Claude Code、Codex、Cursor、Grok、OpenCode、Antigravity、Devin、Pi、omp、fx、Hermes、GitHub、Git、Linear、Jira、Slack、macOS、Windows、Linux、Node.js、Rust、npm、MCP、LLM、API、URL、CLI、JSON、SSH、PTY。
5. 快捷键写法不翻译：Cmd+K、Ctrl+Shift+P、⌘K、⌥、⇧、↩、⎋、Esc、Enter 等保持原样。
6. 标点：句末不加句号；疑问句用 "？"；列举用 "、"；省略号沿用 "…"；括号用全角（）。
7. 技术标识符不翻译：文件名、变量名、路径、命令、包名、CSS 类名、日志前缀、HTTP 头。
8. 语气克制专业，不营销、不口语化。固定译法：session=会话、workspace=工作区、worktree=工作树、pane=窗格、tab=标签页、agent=智能体、provider=服务商、harness=代理运行时、checkpoint=检查点、artifact=产物、transcript=对话记录、commit=提交、diff=差异、branch=分支。`;

const MAX_BATCH_CHARS = 1400;
const MAX_BATCH_ITEMS = 24;
const PLACEHOLDER = /\{\d+\}/g;
const LATIN = /[A-Za-z]/;
const CJK = /[\u4e00-\u9fa5]/;
const ALLOWED_LATIN = /^(?:api|cli|gui|ui|json|http|https|ssh|pty|mcp|llm|url|uri|id|ok|px|ms|kb|mb|gb|vh|vw|rem|em|fr|deg|rgba?|hsla?|var|calc|on|off)$/i;

function parseArgs(argv) {
  const args = { root: ".", workers: 8, limit: Infinity, strict: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i];
    else if (arg === "--workers") args.workers = Number(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--dry-run") args.dryRun = true;
  }
  return args;
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function emptyDictionary() {
  return { version: 1, entries: {}, patterns: {}, kept: {}, menu: { byId: {}, byText: {} }, untranslated: {} };
}

/** Per-group merge so a fresher seed never erases the state branch. */
function mergeDictionary(base, ...layers) {
  const out = emptyDictionary();
  for (const layer of [base, ...layers]) {
    if (!layer) continue;
    for (const group of ["entries", "patterns", "kept", "untranslated"]) {
      Object.assign(out[group], layer[group] ?? {});
    }
    out.menu.byId = { ...out.menu.byId, ...(layer.menu?.byId ?? {}) };
    out.menu.byText = { ...out.menu.byText, ...(layer.menu?.byText ?? {}) };
  }
  return out;
}

/**
 * A string the translator may legitimately leave in English.
 *
 * Only a known brand/token (from KEEP or keep.txt) or a single identifier-like
 * word qualifies. Multi-word labels are UI copy: "GitLab URL" is a field label,
 * not a brand, so echoing it back is a miss, not a decision.
 */
function isKeepable(source, keepWords) {
  if (keepWords.includes(source)) return true;
  if (/\s/.test(source)) return false;
  // Single word: brand-ish casing or a code token, never a lowercase word.
  return /[A-Z]{2,}/.test(source) || /[.\/]/.test(source) || keepWords.some((w) => w === source);
}

/** First run on a fresh clone: start from the committed seed dictionary. */
function loadSeed(root) {
  const candidates = [path.join(root, "tools", "zh-cn", "seed.zh-cn.json")];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  return file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

/** Hand-fixed translations that win over the model. */
function loadOverrides(root) {
  const file = path.join(root, "tools", "zh-cn", "overrides.json");
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  delete parsed._comment;
  return parsed;
}

/** Strings that must stay English (internal logs, protocol constants). */
function loadKeep(root) {
  const file = path.join(root, "tools", "zh-cn", "keep.txt");
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs.readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

function loadGlossary(root) {
  const candidates = [path.join(root, "glossary.json"), path.join(here, "glossary.json")];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  return file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

/**
 * Placeholder compatibility between source and translation.
 *
 * Order may change: Chinese flips them ("Couldn't {0} on {1}" becomes
 * "无法在 {1} 上{0}"). A translation may also drop at most one placeholder, and
 * only when the source has two or more, which is the pluralisation idiom:
 * `${n} ${n===1?"model":"models"} available.` becomes `{0} 个模型可用`, and the
 * unused slot is simply never substituted. Adding or duplicating is refused.
 */
function placeholdersMatch(source, translated) {
  const a = (source.match(PLACEHOLDER) || []).sort();
  const b = (translated.match(PLACEHOLDER) || []).sort();
  if (b.some((token) => !a.includes(token))) return false;
  if (new Set(b).size !== b.length) return false;
  if (a.length === b.length) return true;
  return a.length - b.length === 1 && a.length >= 2;
}

/**
 * True when a translation did not really get translated.
 *
 * The old rule rejected any leftover English word, which threw away good
 * translations such as "Grok Build 未返回会话 id". What actually distinguishes
 * an untranslated reply is the balance between Chinese and leftover Latin:
 * brand names and identifiers legitimately stay English, but the bulk of a
 * translated sentence must be Chinese.
 */
function stillEnglish(source, translation, keepWords) {
  if (!translation || typeof translation !== "string") return true;
  if (!LATIN.test(source)) return false; // nothing to translate
  const body = translation.replace(/\{\d+\}/g, "").replace(/\s+/g, "");
  if (!CJK.test(body)) return true; // no Chinese at all: echoed English
  let rest = body;
  // URLs, domains, emails and dotted/hyphenated identifiers survive as-is and
  // must not count towards "this is still English".
  rest = rest.replace(/https?:\/\/[^\s，。]+/g, "");
  rest = rest.replace(/[\w.+-]+@[\w.-]+/g, "");
  rest = rest.replace(/\b(?:[\w-]+\.)+[a-z]{2,}\b/gi, "");
  rest = rest.replace(/\b[\w-]*[-_.][\w.-]*\b/g, "");
  for (const word of keepWords) rest = rest.split(word).join("");
  const cjk = (rest.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (rest.match(/[A-Za-z]/g) || []).length;
  if (latin === 0) return false;
  if (cjk === 0) return true;
  // Leftover Latin is fine as long as Chinese carries the sentence: brand
  // names ("Atlassian 邮箱"), paths and flags all survive this ratio.
  if (latin > cjk * 3 + 10) return true;
  // A whole English sentence kept verbatim inside a short label is not it.
  const words = rest.match(/\b[A-Za-z]{5,}\b/g) || [];
  const unallowed = words.filter((word) => !ALLOWED_LATIN.test(word));
  return unallowed.length > cjk;
}

function batches(items) {
  const groups = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const cost = item.length + 24;
    if (current.length > 0 && (chars + cost > MAX_BATCH_CHARS || current.length >= MAX_BATCH_ITEMS)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += cost;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function runPool(tasks, concurrency) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const current = index++;
      if (current >= tasks.length) return;
      await tasks[current]();
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const worklistPath = path.join(root, WORKLIST_FILE);
  if (!fs.existsSync(worklistPath)) throw new Error(`${WORKLIST_FILE} missing; run extract.mjs first`);
  const worklist = JSON.parse(fs.readFileSync(worklistPath, "utf8"));
  const dictionary = mergeDictionary(loadSeed(root), loadJson(path.join(root, DICT_FILE), {}));
  dictionary.menu ??= { byId: {}, byText: {} };
  dictionary.patterns ??= {};
  dictionary.kept ??= {};
  dictionary.untranslated ??= {};
  const glossary = loadGlossary(root);
  const forcedKeep = loadKeep(root);
  const overrides = loadOverrides(root);

  const keepWords = [...new Set([...KEEP, ...Object.keys(glossary)])].sort((a, b) => b.length - a.length);

  /** @type {Map<string, {group: string, key?: string}>} */
  const required = new Map();
  for (const item of worklist.exact) required.set(item.text, { group: "entries" });
  for (const item of worklist.patterns) required.set(item.text, { group: "patterns" });
  for (const [id, text] of Object.entries(worklist.menu.items)) required.set(text, { group: "menu", key: id });
  for (const title of worklist.menu.titles) required.set(title, { group: "menu" });
  for (const description of worklist.menu.plistDescriptions) required.set(description.text, { group: "entries" });

  for (const [source, target] of Object.entries(glossary)) dictionary.entries[source] = target;

  const store = (source, translated) => {
    const group = required.get(source)?.group;
    if (group === "patterns") dictionary.patterns[source] = translated;
    else dictionary.entries[source] = translated;
  };
  const lookup = (source) => {
    const group = required.get(source)?.group;
    return group === "patterns" ? dictionary.patterns[source] : dictionary.entries[source];
  };

  // A reject that only tripped the "still looks English" heuristic is still a
  // usable translation; keep it and let the ratio rule decide per string.
  // (Handled by revive below.)
  // Re-evaluate earlier rejects under the current rules before spending calls.
  let revived = 0;
  for (const [source, value] of Object.entries(dictionary.untranslated)) {
    if (!required.has(source)) continue;
    if (stillEnglish(source, value, keepWords) || !placeholdersMatch(source, value)) continue;
    store(source, value);
    delete dictionary.untranslated[source];
    revived += 1;
  }
  if (revived > 0) console.log(`zh-cn: revived ${revived} previously rejected translations`);

  const pending = [];
  for (const [source, meta] of required) {
    if (meta.group === "menu" && dictionary.menu.byId[meta.key ?? ""] === undefined && meta.key) continue;
    if (forcedKeep.has(source)) {
      dictionary.kept[source] = 1;
      delete dictionary.entries[source];
      delete dictionary.patterns[source];
      delete dictionary.untranslated[source];
      continue;
    }
    if (dictionary.kept[source] === 1) continue;
    const cached = lookup(source);
    if (typeof cached === "string" && !stillEnglish(source, cached, keepWords) && placeholdersMatch(source, cached)) continue;
    pending.push(source);
  }

  console.log(`zh-cn: ${required.size} required, ${required.size - pending.length} cached, ${pending.length} to translate`);

  if (pending.length > 0 && args.dryRun) {
    console.log(pending.slice(0, 20).join("\n"));
    return;
  }

  if (pending.length > 0) {
    let provider;
    try {
      provider = resolveProvider();
    } catch (error) {
      console.error(`zh-cn: ${error.message}`);
      console.error("zh-cn: keeping the existing dictionary; coverage will be partial");
      provider = null;
    }
    if (provider) {
      console.log(`zh-cn: ${provider.format} ${provider.model} @ ${provider.baseUrl}`);
      const limited = Number.isFinite(args.limit) ? pending.slice(0, args.limit) : pending;
      const groups = batches(limited);
      let done = 0;
      let failed = 0;
      /**
       * One request per batch. A batch that fails (truncated reply, a gateway
       * hiccup on one long string) is halved and retried, down to one string at
       * a time, so a single bad string cannot cost the whole run.
       */
      const ask = async (group) => {
        const payload = Object.fromEntries(group.map((source) => [source, ""]));
        const reply = await complete(provider, {
          system: SYSTEM,
          user: `把下面 UI 文案译成简体中文，输出 JSON 对象（键保持不变）：\n${JSON.stringify(payload, null, 1)}`,
        });
        return parseJsonObject(reply);
      };

      const collect = (group, parsed) => {
        for (const source of group) {
          const value = typeof parsed[source] === "string" ? parsed[source].trim() : "";
          if (!value) continue;
          if (value === source && isKeepable(source, keepWords)) {
            // Brand names, CSS formulas and code tokens stay English.
            dictionary.kept[source] = 1;
            delete dictionary.entries[source];
            delete dictionary.patterns[source];
            delete dictionary.untranslated[source];
            continue;
          }
          if (stillEnglish(source, value, keepWords) || !placeholdersMatch(source, value)) {
            dictionary.untranslated[source] = value;
            continue;
          }
          store(source, value);
          dictionary.kept[source] = 0;
          delete dictionary.untranslated[source];
        }
      };

      const translateGroup = async (group) => {
        try {
          collect(group, await ask(group));
        } catch (error) {
          if (group.length === 1) {
            console.error(`  string failed: ${group[0].slice(0, 60)} — ${error.message.slice(0, 80)}`);
            return;
          }
          const half = Math.ceil(group.length / 2);
          await translateGroup(group.slice(0, half));
          await translateGroup(group.slice(half));
        }
      };

      await runPool(
        groups.map((group, groupIndex) => async () => {
          await translateGroup(group);
          done += 1;
          if (done % 10 === 0 || done === groups.length) {
            console.log(`zh-cn: batch ${done}/${groups.length}`);
          }
          void groupIndex;
        }),
        args.workers,
      );
      if (failed > 0) console.warn(`zh-cn: ${failed} batches failed; rerun to retry`);
    }
  }

  // Menu table the Rust localizer reads: id -> Chinese, English title -> Chinese.
  dictionary.menu = { byId: {}, byText: {} };
  for (const [id, english] of Object.entries(worklist.menu.items)) {
    const zh = dictionary.entries[english];
    if (zh) dictionary.menu.byId[id] = zh;
  }
  for (const english of worklist.menu.titles) {
    const zh = dictionary.entries[english];
    if (zh) dictionary.menu.byText[english] = zh;
  }

  // Hand-fixed translations win, and count as covered.
  for (const [source, value] of Object.entries(overrides)) {
    if (!required.has(source)) continue;
    store(source, value);
    dictionary.kept[source] = 0;
    delete dictionary.untranslated[source];
  }

  // Drop entries for strings upstream no longer has.
  const wanted = new Set(required.keys());
  for (const group of ["entries", "patterns"]) {
    for (const key of Object.keys(dictionary[group])) {
      if (!wanted.has(key)) delete dictionary[group][key];
    }
  }
  for (const key of Object.keys(dictionary.untranslated)) {
    if (!wanted.has(key)) delete dictionary.untranslated[key];
  }
  for (const key of Object.keys(dictionary.kept)) {
    if (!wanted.has(key)) delete dictionary.kept[key];
  }

  const missing = [...required.keys()].filter((source) => {
    if (dictionary.kept[source] === 1) return false;
    const value = lookup(source);
    return typeof value !== "string" || stillEnglish(source, value, keepWords) || !placeholdersMatch(source, value);
  });

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: Object.fromEntries(Object.entries(dictionary.entries).sort(([a], [b]) => a.localeCompare(b))),
    patterns: Object.fromEntries(Object.entries(dictionary.patterns).sort(([a], [b]) => a.localeCompare(b))),
    kept: dictionary.kept,
    menu: dictionary.menu,
    untranslated: dictionary.untranslated,
    missing,
  };
  fs.mkdirSync(path.dirname(path.join(root, DICT_FILE)), { recursive: true });
  fs.writeFileSync(path.join(root, DICT_FILE), `${JSON.stringify(output, null, 1)}\n`);

  const total = required.size;
  const covered = total - missing.length;
  console.log(
    `zh-cn: ${covered}/${total} translated (${total === 0 ? 100 : Math.round((covered / total) * 100)}%), ` +
      `${missing.length} missing, ${Object.keys(output.untranslated).length} rejected`,
  );
  if (missing.length > 0 && args.strict) {
    console.error(`zh-cn: strict mode, ${missing.length} strings are untranslated`);
    for (const source of missing.slice(0, 15)) console.error(`  - ${source}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`zh-cn translate failed: ${error.stack || error.message}`);
  process.exit(1);
});
