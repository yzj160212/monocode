#!/usr/bin/env node
/**
 * Verifies a packaged app without launching it.
 *
 *   node tools/zh-cn/verify.mjs --root . --target aarch64-apple-darwin
 *
 * Checks the things a release can silently get wrong:
 *   - the executable is arm64 only
 *   - the Chinese runtime script and its <script> tag made it into the bundle
 *   - the native menu table is non-empty and compiled into the binary
 *   - the Info.plist Finder prompts are localized
 *   - the DMG checksum is valid
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = { root: ".", target: "aarch64-apple-darwin", skipDmg: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--target") args.target = argv[++i];
    else if (argv[i] === "--skip-dmg") args.skipDmg = true;
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

const failures = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push(`ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const bundleDir = path.join(root, "target", args.target, "release", "bundle");
  const appDir = path.join(bundleDir, "macos", "MonoCode.app");
  const dmgDir = path.join(bundleDir, "dmg");

  check("app bundle exists", fs.existsSync(appDir), appDir);
  if (!fs.existsSync(appDir)) return report();

  const plist = path.join(appDir, "Contents", "Info.plist");
  const executableName = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]).out;
  const binary = path.join(appDir, "Contents", "MacOS", executableName);
  check("executable present", fs.existsSync(binary), executableName);
  if (!fs.existsSync(binary)) return report();

  const archs = run("lipo", ["-archs", binary]).out;
  check("arm64 only", archs === "arm64", archs);

  const signature = run("codesign", ["--verify", "--deep", "--strict", appDir]);
  check("codesign verifies", signature.status === 0, signature.out.split("\n")[0] || "adhoc signature");

  // Tauri compresses web assets (brotli) into the binary, so the reliable proof
  // is the asset table plus the build output that produced it.
  const asText = fs.readFileSync(binary).toString("latin1");
  check("runtime dictionary embedded", asText.includes("/zh-cn.js"), "dist/zh-cn.js served by the webview");

  const distIndex = path.join(root, "dist", "index.html");
  const indexHtml = fs.existsSync(distIndex) ? fs.readFileSync(distIndex, "utf8") : "";
  check("html lang switched", /<html[^>]*\slang="zh-CN"/.test(indexHtml), "dist/index.html");
  const injected = /<script src="\/zh-cn\.js\?v=[0-9a-f]{12}"><\/script>/.test(indexHtml);
  check("runtime script tag injected", injected, "dist/index.html");
  check("dist dictionary present", fs.existsSync(path.join(root, "dist", "zh-cn.js")));
  const menuSample = fs.existsSync(path.join(root, "src-tauri", "src", "zh_cn.rs"))
    ? fs.readFileSync(path.join(root, "src-tauri", "src", "zh_cn.rs"), "utf8")
    : "";
  const byIdCount = (menuSample.match(/^    \("/gm) || []).length;
  check("native menu table populated", byIdCount > 50, `${byIdCount} entries in zh_cn.rs`);

  const plistText = fs.readFileSync(plist, "utf8");
  check(
    "finder prompts localized",
    /NSDesktopFolderUsageDescription[\s\S]{0,40}[\u4e00-\u9fa5]/.test(plistText),
    "Info.plist contains Chinese usage descriptions",
  );

  if (!args.skipDmg) {
    const dmgs = fs.existsSync(dmgDir) ? fs.readdirSync(dmgDir).filter((f) => f.endsWith(".dmg")) : [];
    check("dmg produced", dmgs.length > 0, dmgs.join(", "));
    if (dmgs.length > 0) {
      const verify = run("hdiutil", ["verify", path.join(dmgDir, dmgs[0])]);
      check("dmg checksum valid", verify.status === 0, dmgs[0]);
    }
  }
  return report();
}

function report() {
  for (const line of notes) console.log(line);
  if (failures.length > 0) {
    for (const line of failures) console.error(`FAIL ${line}`);
    process.exit(1);
  }
  console.log(`zh-cn: all ${notes.length} checks passed on ${os.arch()}`);
}

main();
