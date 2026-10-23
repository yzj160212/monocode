#!/usr/bin/env node
/**
 * Builds the translation work list: every string the runtime layer can rewrite.
 *
 *   node tools/zh-cn/extract.mjs [--root .] [--out .zh-cn/worklist.json]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { collectAll } from "./lib/collect.mjs";
import { extractMenuStrings } from "./lib/menu-extract.mjs";

const require = createRequire(import.meta.url);

export function loadTypeScript(root) {
  try {
    return require(path.join(root, "node_modules", "typescript"));
  } catch {
    return require("typescript");
  }
}

export function sourceFiles(root) {
  const dir = path.join(root, "src");
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(entry.name) && !/\.(test|spec|bench)\./.test(entry.name)) {
        files.push(path.relative(root, p));
      }
    }
  };
  walk(dir);
  return files.sort();
}

export function extract(root) {
  const ts = loadTypeScript(root);
  const exact = new Map();
  const patterns = new Map();

  for (const rel of sourceFiles(root)) {
    const code = fs.readFileSync(path.join(root, rel), "utf8");
    const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, kind);
    let found;
    try {
      found = collectAll(ts, sourceFile, code);
    } catch (error) {
      console.warn(`  skip ${rel}: ${error.message}`);
      continue;
    }
    for (const [text, kinds] of found.exact) {
      if (!exact.has(text)) exact.set(text, { count: 0, kinds: new Set(), files: new Set() });
      const rec = exact.get(text);
      rec.count += 1;
      rec.files.add(rel);
      for (const k of kinds) rec.kinds.add(k);
    }
    for (const [text, kinds] of found.patterns) {
      if (!patterns.has(text)) patterns.set(text, { count: 0, kinds: new Set(), files: new Set() });
      const rec = patterns.get(text);
      rec.count += 1;
      rec.files.add(rel);
      for (const k of kinds) rec.kinds.add(k);
    }
  }

  const rank = (a, b) => b.count - a.count || a.text.localeCompare(b.text);
  const shape = (rec) => ({ count: rec.count, kinds: [...rec.kinds], files: [...rec.files].slice(0, 4) });

  return {
    exact: [...exact.entries()]
      .map(([text, rec]) => ({ text, ...shape(rec) }))
      .sort(rank),
    patterns: [...patterns.entries()]
      .map(([text, rec]) => ({ text, ...shape(rec) }))
      .sort(rank),
    menu: extractMenuStrings(root),
  };
}

function parseArgs(argv) {
  const args = { root: ".", out: ".zh-cn/worklist.json", quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--quiet") args.quiet = true;
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = extract(path.resolve(args.root));
  const outPath = path.resolve(args.root, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 1)}\n`);
  if (!args.quiet) {
    console.log(
      `zh-cn: ${result.exact.length} exact strings, ${result.patterns.length} patterns, ` +
        `${Object.keys(result.menu.items).length} menu items, ${result.menu.titles.length} menu titles`,
    );
  }
}
