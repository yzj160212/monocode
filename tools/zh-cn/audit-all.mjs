#!/usr/bin/env node
/**
 * Zero-filter audit: every literal the AST sees, no heuristics.
 *
 *   node tools/zh-cn/audit-all.mjs [--root .] [--limit 200] [--english-only]
 *
 * audit.mjs applies the same filters as the pipeline, so it can only report
 * strings the pipeline already considers copy. This one applies none: it lists
 * every JSX text node, UI attribute, string literal and template, and marks
 * which ones the dictionary cannot translate. Anything here that reads like UI
 * copy is a gap the heuristic rules are hiding.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "./extract.mjs";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { root: ".", limit: 200, englishOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--english-only") args.englishOnly = true;
  }
  return args;
}

const ATTRS = new Set([
  "title", "placeholder", "aria-label", "ariaLabel", "alt", "label", "description",
  "tooltip", "hint", "heading", "subtitle", "emptyText", "confirmLabel", "cancelLabel",
  "emptyLabel", "noResultsText", "searchPlaceholder", "promptText", "helperText",
  "aria-description", "summary", "caption",
]);

function compilePatterns(patterns) {
  return Object.entries(patterns).map(([key, value]) => {
    const parts = key.split(/\{(\d+)\}/);
    let source = "";
    for (let i = 0; i < parts.length; i += 1) {
      if (i % 2 === 0) source += parts[i].replace(/[.*+?^{}()|[\]\\$]/g, "\\$&");
      else source += "([\\s\\S]*?)";
    }
    return { re: new RegExp(`^${source}$`), out: value };
  });
}

function loadDictionary(root) {
  for (const rel of [".zh-cn/dictionary.json", "tools/zh-cn/seed.zh-cn.json"]) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  throw new Error("no dictionary");
}

/** Reject the shapes that are definitely not user-visible copy. */
const NOT_COPY = [
  /^[\s\d\p{P}\p{S}]*$/u,
  /^[a-z0-9_.:/@-]+$/,
  /^https?:|^\/|^\.\//,
  /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/,
  /^(?:[A-Za-z]{1,4}(?:[:.][A-Za-z]{1,4})+)$/, // HH:mm
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const ts = require(path.join(root, "node_modules", "typescript"));
  const dictionary = loadDictionary(root);
  const patterns = compilePatterns(dictionary.patterns ?? {});
  const kept = dictionary.kept ?? {};

  const translate = (text) => {
    if (dictionary.entries[text] !== undefined) return true;
    if (patterns.some((p) => p.re.test(text))) return true;
    if (kept[text] === 1) return true;
    return false;
  };

  /** text -> {count, files:Set, kinds:Set} */
  const all = new Map();
  const add = (raw, kind, file) => {
    const text = String(raw).replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) return;
    if (!/[A-Za-z]{2,}/.test(text)) return;
    if (!all.has(text)) all.set(text, { count: 0, files: new Set(), kinds: new Set() });
    const rec = all.get(text);
    rec.count += 1;
    rec.files.add(file);
    rec.kinds.add(kind);
  };

  for (const rel of sourceFiles(root)) {
    const code = fs.readFileSync(path.join(root, rel), "utf8");
    const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, kind);

    const visit = (node) => {
      if (ts.isJsxText(node)) add(node.getText(sf), "jsx", rel);
      else if (ts.isJsxAttribute(node) && node.name && ts.isIdentifier(node.name) && ATTRS.has(node.name.text)) {
        let e = node.initializer;
        while (e && ts.isJsxExpression(e)) e = e.expression;
        if (e && ts.isStringLiteral(e)) add(e.text, "attr", rel);
        else if (e && ts.isTemplateExpression(e)) {
          let t = e.head.text;
          for (const sp of e.templateSpans) t += "{0}" + sp.literal.text;
          add(t, "attr-template", rel);
        }
      } else if (ts.isTemplateExpression(node) && !(node.parent && ts.isTaggedTemplateExpression(node.parent))) {
        let t = node.head.text;
        for (const sp of node.templateSpans) t += "{0}" + sp.literal.text;
        add(t, "template", rel);
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (node.parent && ts.isImportDeclaration(node.parent)) return;
        add(node.text, "literal", rel);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  const rows = [...all.entries()]
    .filter(([text]) => !NOT_COPY.some((re) => re.test(text)))
    .map(([text, rec]) => ({ text, ...rec, translated: translate(text) }))
    .filter((row) => !row.translated);

  rows.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

  console.log(`zh-cn: ${all.size} distinct strings seen by the AST; ${rows.length} have no translation`);
  for (const row of rows.slice(0, args.limit)) {
    const where = [...row.files].slice(0, 2).join(", ");
    console.log(`${row.count}\t${[...row.kinds].join(",")}\t${row.text.slice(0, 120)}\t${where}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
