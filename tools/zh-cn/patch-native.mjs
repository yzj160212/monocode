#!/usr/bin/env node
/**
 * Injects the native macOS localization into src-tauri.
 *
 *   node tools/zh-cn/patch-native.mjs [--root .]
 *
 * Writes src-tauri/src/zh_cn.rs, hooks it into lib.rs, and localizes
 * src-tauri/Info.plist. All three are restored by `git checkout` after the
 * build, so upstream syncs never conflict.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookLibRs, hookMenuRs, writeLocalizedPlist, writeNativeModule } from "./lib/native.mjs";

function parseArgs(argv) {
  const args = { root: "." };
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--root") args.root = argv[++i];
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const dictionaryPath = path.join(root, ".zh-cn", "dictionary.json");
  // A build without credentials still produces a usable (partly translated)
  // app, so a missing dictionary degrades to "English menu" instead of failing.
  const dictionary = fs.existsSync(dictionaryPath)
    ? JSON.parse(fs.readFileSync(dictionaryPath, "utf8"))
    : { entries: {}, patterns: {}, kept: {}, menu: { byId: {}, byText: {} } };

  const worklistPath = path.join(root, ".zh-cn", "worklist.json");
  const worklist = JSON.parse(fs.readFileSync(worklistPath, "utf8"));
  const plist = {};
  for (const { key, text } of worklist.menu.plistDescriptions) {
    const zh = dictionary.entries[text];
    if (zh) plist[key] = zh;
  }

  // Dock menu items are built with AppKit directly, so they need their own
  // English -> Chinese table from the strings found in macos.rs.
  const dockMenu = {};
  for (const english of worklist.menu.dockTitles ?? []) {
    const zh = dictionary.entries[english];
    if (zh) dockMenu[english] = zh;
  }

  const modulePath = writeNativeModule(root, {
    menu: { ...dictionary.menu, dockMenu },
    dictionary: dictionary.entries,
    plist,
  });
  const hooked = hookLibRs(root);
  const menuHooked = hookMenuRs(root);
  const plistPath = writeLocalizedPlist(root, plist);

  console.log(
    `zh-cn: wrote ${path.relative(root, modulePath)} ` +
      `(${Object.keys(dictionary.menu?.byId ?? {}).length} items, ${Object.keys(dictionary.menu?.byText ?? {}).length} titles), ` +
      `lib.rs ${hooked ? "patched" : "already current"}, ` +
      `menu.rs ${menuHooked ? "patched" : "already current"}, ` +
      `${plistPath ? `plist ${path.relative(root, plistPath)}` : "plist unchanged"}`,
  );
}
