#!/usr/bin/env node
/**
 * Injects the Chinese layer into `dist/` (run after `npm run build`).
 *
 *   node tools/zh-cn/postbuild.mjs [--root .] [--dist dist]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postBuild } from "./lib/postbuild.mjs";

function parseArgs(argv) {
  const args = { root: ".", dist: "dist" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--dist") args.dist = argv[++i];
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const manifest = postBuild(path.resolve(args.root), { distDir: args.dist });
  console.log(
    `zh-cn: injected ${manifest.entries} strings + ${manifest.patterns} patterns into ` +
      `${manifest.files.length} HTML entries (${manifest.hash})`,
  );
}
