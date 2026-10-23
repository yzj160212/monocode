#!/usr/bin/env node
/**
 * Coverage audit: reports UI copy that the dictionary does not translate yet.
 *
 *   node tools/zh-cn/audit.mjs [--root .] [--limit 60]
 *
 * This is deliberately stricter than extract.mjs: it inspects every JSX text
 * node and UI attribute, then asks "would the runtime layer change this text?".
 * Anything reported here is English a user can still see in the app.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "./extract.mjs";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { root: ".", limit: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
  }
  return args;
}

const UI_ATTRS = new Set([
  "title", "placeholder", "aria-label", "ariaLabel", "alt", "label", "description",
  "tooltip", "hint", "heading", "subtitle", "emptyText", "confirmLabel", "cancelLabel",
  "emptyLabel", "noResultsText", "searchPlaceholder", "promptText", "helperText",
  "aria-description", "summary", "caption",
]);

/** Same pattern compiler the runtime uses. */
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

function translate(value, entries, patterns) {
  const core = value.replace(/\s+/g, " ").trim();
  if (!core) return null;
  if (entries[core] !== undefined) return entries[core];
  for (const pattern of patterns) {
    const match = pattern.re.exec(core);
    if (match) return pattern.out;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const ts = require(path.join(root, "node_modules", "typescript"));
  const dictionaryPath = path.join(root, ".zh-cn", "dictionary.json");
  const dictionary = fs.existsSync(dictionaryPath)
    ? JSON.parse(fs.readFileSync(dictionaryPath, "utf8"))
    : { entries: {}, patterns: {}, kept: {} };
  const patterns = compilePatterns(dictionary.patterns ?? {});

  /** English -> {count, files:Set} */
  const uncovered = new Map();
  const covered = new Set();
  let total = 0;

  const note = (text, file) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || !/[A-Za-z]{2,}/.test(normalized)) return;
    total += 1;
    if (translate(normalized, dictionary.entries, patterns)) {
      covered.add(normalized);
      return;
    }
    if (!uncovered.has(normalized)) uncovered.set(normalized, { count: 0, files: new Set() });
    const rec = uncovered.get(normalized);
    rec.count += 1;
    rec.files.add(file);
  };

  for (const rel of sourceFiles(root)) {
    const code = fs.readFileSync(path.join(root, rel), "utf8");
    const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, kind);

    const visit = (node) => {
      if (ts.isJsxText(node)) {
        note(node.getText(sourceFile), rel);
      } else if (ts.isJsxAttribute(node) && node.name && ts.isIdentifier(node.name) && UI_ATTRS.has(node.name.text)) {
        const init = node.initializer;
        let expr = init;
        while (expr && ts.isJsxExpression(expr)) expr = expr.expression;
        if (expr && ts.isStringLiteral(expr)) note(expr.text, rel);
      } else if (ts.isJsxExpression(node) && node.parent && ts.isJsxElement(node.parent)) {
        let expr = node.expression;
        while (expr && ts.isParenthesizedExpression(expr)) expr = expr.expression;
        if (expr && ts.isStringLiteral(expr)) note(expr.text, rel);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  const rows = [...uncovered.entries()]
    .map(([text, rec]) => ({ text, count: rec.count, files: [...rec.files] }))
    .filter((row) => row.text.length > 1)
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

  console.log(
    `zh-cn audit: ${total} visible strings, ${covered.size} translated, ${rows.length} uncovered`,
  );
  for (const row of rows.slice(0, args.limit)) {
    const where = row.files.slice(0, 2).join(", ");
    console.log(`${row.count}\t${row.text.slice(0, 110)}\t${where}`);
  }
  if (rows.length > 0) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
