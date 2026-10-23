#!/usr/bin/env node
/**
 * One entry point for the localized frontend build.
 *
 *   node tools/zh-cn/build.mjs
 *
 * Runs the normal TypeScript + Vite build, then bakes the Chinese runtime layer
 * into dist/. This is the command `tauri build` invokes through the override
 * config at tools/zh-cn/tauri.zh-cn.conf.json, which is why `zh-cn.js` ends up
 * inside the packaged app instead of being overwritten by tauri's own
 * `npm run build`.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { postBuild } from "./lib/postbuild.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    // Windows resolves `npx` through a .cmd shim.
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status ?? result.signal}`);
  }
}

run("npx", ["tsc"]);
run("npx", ["vite", "build"]);

const manifest = postBuild(root, { distDir: "dist" });
console.log(
  `zh-cn: dist ready — ${manifest.entries} strings, ${manifest.patterns} patterns, ` +
    `${manifest.files.length} HTML entries (${manifest.hash})`,
);
