/**
 * Extracts native macOS menu strings from src-tauri so they can be translated.
 *
 * Two kinds are collected:
 *   - items:  (menu id -> English label) from menu.rs builders and the Dock menu
 *   - titles: (English text -> itself) for submenu captions and the predefined
 *             items macOS draws (Undo, Cut, Hide Others, ...), which the Rust
 *             side localizes by comparing the current text.
 */
import fs from "node:fs";
import path from "node:path";

const ITEM_PATTERNS = [
  // menu_item(app, "id", "Text", "Accel", "Cmd", overrides)
  /menu_item\(\s*&?app,\s*"([\w-]+)",\s*"((?:[^"\\]|\\.)*)"/g,
  // MenuItemBuilder::with_id("id", "Text")
  /MenuItemBuilder::with_id\(\s*"([\w-]+)",\s*"((?:[^"\\]|\\.)*)"/g,
  // CheckMenuItem::with_id(app, "id", "Text", ...)
  /CheckMenuItem::with_id\(\s*&?app,\s*"([\w-]+)",\s*"((?:[^"\\]|\\.)*)"/g,
];

const SUBMENU_PATTERNS = [
  // SubmenuBuilder::with_id(app, "file", "File") — the id may be a literal,
  // an identifier, or a tauri::menu::* constant.
  /SubmenuBuilder::with_id\(\s*&?app,\s*(?:"[\w-]+"|tauri::menu::\w+|\w+),\s*"((?:[^"\\]|\\.)*)"/g,
  /SubmenuBuilder::new\(\s*&?app,\s*"((?:[^"\\]|\\.)*)"/g,
];

/** Menu ids whose visible label comes from a platform constant, not a literal. */
const CONST_SUBMENUS = [
  { pattern: /tauri::menu::WINDOW_SUBMENU_ID,\s*"((?:[^"\\]|\\.)*)"/g, file: "menu.rs" },
  { pattern: /tauri::menu::HELP_SUBMENU_ID,\s*"((?:[^"\\]|\\.)*)"/g, file: "menu.rs" },
];

/**
 * Default captions produced by muda for predefined items. macOS renders these
 * with the app name substituted where relevant; the Rust localizer strips
 * accelerators and compares the visible text.
 */
export const PREDEFINED_TEXTS = [
  "Undo", "Redo", "Cut", "Copy", "Paste", "Select All",
  "Minimize", "Zoom", "Toggle Full Screen", "Close Window",
  "Hide MonoCode", "Hide Others", "Show All", "Quit MonoCode",
  "About MonoCode", "Services", "Bring All to Front",
];

export function extractMenuStrings(root) {
  const srcDir = path.join(root, "src-tauri", "src");
  const items = new Map();
  const titles = new Set();

  const menuRs = path.join(srcDir, "menu.rs");
  if (fs.existsSync(menuRs)) {
    const code = fs.readFileSync(menuRs, "utf8");
    for (const re of ITEM_PATTERNS) {
      for (const match of code.matchAll(re)) {
        const [, id, text] = match;
        if (!id || !text) continue;
        items.set(id, text.replace(/\\(["\\])/g, "$1"));
        titles.add(text);
      }
    }
    for (const re of SUBMENU_PATTERNS) {
      for (const match of code.matchAll(re)) titles.add(match[1]);
    }
    for (const { pattern } of CONST_SUBMENUS) {
      for (const match of code.matchAll(pattern)) titles.add(match[1]);
    }
  }

  // Dock context menu built directly with AppKit.
  const macosRs = path.join(srcDir, "macos.rs");
  const dockTitles = [];
  if (fs.existsSync(macosRs)) {
    const code = fs.readFileSync(macosRs, "utf8");
    for (const match of code.matchAll(/NSMenuItem::initWithTitle_action_keyEquivalent\(\s*NSMenuItem::alloc\(mtm\),\s*&NSString::from_str\("((?:[^"\\]|\\.)*)"\)/g)) {
      titles.add(match[1]);
      dockTitles.push(match[1]);
    }
  }

  // Finder permission prompts live in the bundle Info.plist.
  const plist = path.join(root, "src-tauri", "Info.plist");
  const plistDescriptions = [];
  if (fs.existsSync(plist)) {
    const xml = fs.readFileSync(plist, "utf8");
    for (const match of xml.matchAll(/<key>(NS\w+UsageDescription)<\/key>\s*<string>((?:[^<]|&amp;)*)<\/string>/g)) {
      plistDescriptions.push({ key: match[1], text: match[2].replace(/&amp;/g, "&") });
      titles.add(match[2].replace(/&amp;/g, "&"));
    }
  }

  for (const text of PREDEFINED_TEXTS) titles.add(text);

  return {
    items: Object.fromEntries([...items.entries()].sort(([a], [b]) => a.localeCompare(b))),
    titles: [...titles].filter((text) => /[A-Za-z]/.test(text)).sort(),
    dockTitles,
    plistDescriptions,
  };
}

/** Writes a localizable copy of Info.plist for the Chinese bundle. */
export function localizePlist(root, dictionary) {
  const input = path.join(root, "src-tauri", "Info.plist");
  if (!fs.existsSync(input)) return null;
  let xml = fs.readFileSync(input, "utf8");
  for (const [key, zh] of Object.entries(dictionary)) {
    const escaped = zh.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    xml = xml.replace(
      new RegExp(`(<key>${key}</key>\\s*<string>)(?:[^<]*)</string>`),
      `$1${escaped}</string>`,
    );
  }
  const output = path.join(root, "src-tauri", "Info.zh.plist");
  fs.writeFileSync(output, xml);
  return output;
}
