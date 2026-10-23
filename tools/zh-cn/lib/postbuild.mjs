/**
 * Post-build injection into `dist/`.
 *
 * Runs after `vite build` and before `tauri build`, so the Chinese layer is
 * baked into the bundle that gets packaged into the DMG:
 *
 *   - dist/zh-cn.js            runtime dictionary (exact strings + patterns)
 *   - <script> tag             added to every HTML entry point, before the app
 *   - dist/index.html lang     switched to zh-CN
 *
 * Injected assets are listed in .zh-cn/manifest.json so a rebuild can restore a
 * pristine dist/ without a full vite rerun.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { renderRuntimeScript } from "./runtime-script.mjs";

const SCRIPT_RE = /\s*<script src="\/zh-cn\.js[^"]*"><\/script>/g;
const MARKER = "<!-- zh-cn -->";

function htmlFiles(dist) {
  return fs
    .readdirSync(dist)
    .filter((name) => name.endsWith(".html"))
    .map((name) => path.join(dist, name));
}

/** Injects the runtime script tag into one HTML file. */
export function injectHtml(html, hash) {
  const cleaned = html.replace(SCRIPT_RE, "").replace(new RegExp(`\\s*${MARKER}`, "g"), "");
  const tag = `${MARKER}\n    <script src="/zh-cn.js?v=${hash}"></script>`;
  let out = cleaned.replace(/<head([^>]*)>/i, (match) => `${match}${tag}`);
  if (out === cleaned) throw new Error("no <head> to inject into");
  out = out.replace(/<html([^>]*)\slang="[^"]*"/i, '<html$1 lang="zh-CN"');
  if (!/<html[^>]*\slang="zh-CN"/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, '<html$1 lang="zh-CN">');
  }
  return out;
}

/**
 * @param {string} root repo root
 * @param {{distDir?: string}} options
 */
export function postBuild(root, { distDir = "dist" } = {}) {
  const dist = path.join(root, distDir);
  if (!fs.existsSync(dist)) throw new Error(`${distDir}/ missing; run the frontend build first`);

  // Fall back to the committed seed. Without it a build that never ran
  // translate.mjs (first run, or no credentials) would silently inject an empty
  // dictionary and ship an all-English app.
  const dictionary = loadDictionary(root);
  if (Object.keys(dictionary.entries).length === 0 && Object.keys(dictionary.patterns).length === 0) {
    throw new Error("no translations available: .zh-cn/dictionary.json and the seed are both empty");
  }

  const payload = {
    entries: dropKept(dictionary.entries, dictionary.kept),
    patterns: dropKept(dictionary.patterns, dictionary.kept),
  };
  const script = renderRuntimeScript(payload, { hash: shortHash(payload) });
  const scriptPath = path.join(dist, "zh-cn.js");
  fs.writeFileSync(scriptPath, script);

  const hash = shortHash(payload);
  const touched = [];
  for (const file of htmlFiles(dist)) {
    const html = fs.readFileSync(file, "utf8");
    const next = injectHtml(html, hash);
    fs.writeFileSync(file, next);
    touched.push(path.relative(dist, file));
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    hash,
    entries: Object.keys(payload.entries).length,
    patterns: Object.keys(payload.patterns).length,
    files: touched,
  };
  fs.mkdirSync(path.join(root, ".zh-cn"), { recursive: true });
  fs.writeFileSync(path.join(root, ".zh-cn", "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);

  return manifest;
}

/** Working dictionary if present, else the committed seed snapshot. */
function loadDictionary(root) {
  const candidates = [
    path.join(root, ".zh-cn", "dictionary.json"),
    path.join(root, "tools", "zh-cn", "seed.zh-cn.json"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      return { entries: parsed.entries ?? {}, patterns: parsed.patterns ?? {}, kept: parsed.kept ?? {} };
    }
  }
  return { entries: {}, patterns: {}, kept: {} };
}

/** Strings the translator deliberately left in English are not rewritten. */
function dropKept(table, kept = {}) {
  const out = {};
  for (const [source, target] of Object.entries(table ?? {})) {
    if (kept[source] === 1) continue;
    if (typeof target !== "string" || !target.trim() || target === source) continue;
    out[source] = target;
  }
  return out;
}

function shortHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}
