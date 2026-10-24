#!/usr/bin/env node
/**
 * End-to-end check of the pipeline's failure modes, without touching the repo.
 *
 *   node tools/zh-cn/pipeline.test.mjs   (or: npm run zh-cn:test)
 *
 * Covers the cases that silently shipped the wrong app in practice:
 *   - a build with no dictionary at all (first run / missing credentials)
 *   - a configured gateway that returns nothing (coverage collapse)
 *   - a dictionary that upstream made stale
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { postBuild } from "./lib/postbuild.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Minimal dist/ so postBuild has something to rewrite. */
function makeDist(dir) {
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "dist", "index.html"),
    '<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /></head>\n  <body><div id="root"></div></body>\n</html>\n',
  );
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zh-cn-"));
  makeDist(dir);
  return dir;
}

test("falls back to the committed seed when no dictionary was produced", () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, "tools", "zh-cn"), { recursive: true });
  fs.copyFileSync(path.join(root, "tools", "zh-cn", "seed.zh-cn.json"), path.join(dir, "tools", "zh-cn", "seed.zh-cn.json"));

  const manifest = postBuild(dir);
  assert.ok(manifest.entries > 100, `expected seed entries, got ${manifest.entries}`);
  const script = fs.readFileSync(path.join(dir, "dist", "zh-cn.js"), "utf8");
  assert.match(script, /取消|打开项目/, "seed translations must reach dist");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses to inject an empty language layer", () => {
  const dir = sandbox();
  assert.throws(() => postBuild(dir), /no translations available/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prefers a fresh dictionary over the seed", () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, ".zh-cn"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".zh-cn", "dictionary.json"),
    JSON.stringify({ entries: { Cancel: "取消X" }, patterns: {}, kept: {} }),
  );
  fs.mkdirSync(path.join(dir, "tools", "zh-cn"), { recursive: true });
  fs.copyFileSync(path.join(root, "tools", "zh-cn", "seed.zh-cn.json"), path.join(dir, "tools", "zh-cn", "seed.zh-cn.json"));

  const manifest = postBuild(dir);
  assert.equal(manifest.entries, 1);
  assert.match(fs.readFileSync(path.join(dir, "dist", "zh-cn.js"), "utf8"), /取消X/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("drops translations for strings upstream no longer has", () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, ".zh-cn"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".zh-cn", "dictionary.json"),
    JSON.stringify({ entries: { Cancel: "取消" }, patterns: {}, kept: {} }),
  );
  fs.writeFileSync(
    path.join(dir, ".zh-cn", "worklist.json"),
    JSON.stringify({
      exact: [{ text: "Open project", count: 1, kinds: ["jsx"], files: [] }],
      patterns: [],
      menu: { items: {}, titles: [], plistDescriptions: [], dockTitles: [] },
    }),
  );

  // translate.mjs prunes against the worklist; assert the pruning contract here
  // by running it with no credentials (it must still write a pruned dictionary).
  const result = spawnSync(process.execPath, [path.join(root, "tools", "zh-cn", "translate.mjs"), "--root", dir], {
    cwd: root,
    // This case asserts pruning, not coverage: disable the coverage floor.
    env: { ...process.env, ZH_TRANSLATE_API_KEY: "", GITHUB_TOKEN: "", GH_TOKEN: "", ZH_CN_MIN_COVERAGE: "0" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(dir, ".zh-cn", "dictionary.json"), "utf8"));
  assert.equal(written.entries.Cancel, undefined, "stale entry must be pruned");
  assert.ok(written.missing.includes("Open project"), "new string must be reported missing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("injection is idempotent", () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, ".zh-cn"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".zh-cn", "dictionary.json"),
    JSON.stringify({ entries: { Cancel: "取消" }, patterns: {}, kept: {} }),
  );
  postBuild(dir);
  postBuild(dir);
  const html = fs.readFileSync(path.join(dir, "dist", "index.html"), "utf8");
  assert.equal((html.match(/zh-cn\.js/g) || []).length, 1, "script tag must appear once");
  assert.equal((html.match(/<!-- zh-cn -->/g) || []).length, 1, "marker must appear once");
  assert.match(html, /lang="zh-CN"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
