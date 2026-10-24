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
import { extract } from "./extract.mjs";
import { hookLibRs, hookMenuRs, writeLocalizedPlist, writeNativeModule } from "./lib/native.mjs";
import { dropKept, loadDictionary } from "./lib/dictionary.mjs";

function parseArgs(argv) {
  const args = { root: "." };
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--root") args.root = argv[++i];
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  // 与 webview 层共用同一加载器：.zh-cn/dictionary.json → 已提交的 seed → 人工订正。
  const dictionary = loadDictionary(root);
  const entries = dropKept(dictionary.entries, dictionary.kept);

  // The CLI can run standalone (fresh clone, debugging), so derive the menu
  // tables from the sources instead of demanding a prior extract run.
  const worklistPath = path.join(root, ".zh-cn", "worklist.json");
  const worklist = fs.existsSync(worklistPath)
    ? JSON.parse(fs.readFileSync(worklistPath, "utf8"))
    : extract(root);

  // 菜单表按当前字典现算，不从文件里读上一轮的旧表：手工补进来的译文也要进原生
  // 菜单，否则会出现界面中文、菜单栏英文。
  const menu = { byId: {}, byText: {}, dockMenu: {} };
  for (const [id, english] of Object.entries(worklist.menu.items)) {
    const zh = entries[english];
    if (zh) menu.byId[id] = zh;
  }
  for (const english of worklist.menu.titles) {
    const zh = entries[english];
    if (zh) menu.byText[english] = zh;
  }
  // Dock menu items are built with AppKit directly, so they need their own
  // English -> Chinese table from the strings found in macos.rs.
  for (const english of worklist.menu.dockTitles ?? []) {
    const zh = entries[english];
    if (zh) menu.dockMenu[english] = zh;
  }

  const plist = {};
  for (const { key, text } of worklist.menu.plistDescriptions) {
    const zh = entries[text];
    if (zh) plist[key] = zh;
  }

  const modulePath = writeNativeModule(root, { menu, plist });
  const hooked = hookLibRs(root);
  const menuHooked = hookMenuRs(root);
  const plistPath = writeLocalizedPlist(root, plist);

  console.log(
    `zh-cn: wrote ${path.relative(root, modulePath)} ` +
      `(${Object.keys(menu.byId).length} items, ${Object.keys(menu.byText).length} titles), ` +
      `lib.rs ${hooked ? "patched" : "already current"}, ` +
      `menu.rs ${menuHooked ? "patched" : "already current"}, ` +
      `${plistPath ? `plist ${path.relative(root, plistPath)}` : "plist unchanged"}`,
  );
}
