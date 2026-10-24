#!/usr/bin/env node
/**
 * Which dictionary a run uses, and what wins inside it.
 *
 *   node tools/zh-cn/dictionary.test.mjs   (or: npm run zh-cn:test)
 *
 * The case that shipped a half-English app: a hand-fixed translation lived only
 * in overrides.json, which translate.mjs applies — so it did nothing whenever
 * the translate step was skipped (no credentials, fresh clone), and the native
 * menu read a stale table out of the seed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dropKept, loadDictionary } from "./lib/dictionary.mjs";
import { postBuild } from "./lib/postbuild.mjs";

function sandbox({ seed, overrides, dictionary } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zh-cn-dict-"));
  fs.mkdirSync(path.join(dir, "tools", "zh-cn"), { recursive: true });
  if (seed) fs.writeFileSync(path.join(dir, "tools", "zh-cn", "seed.zh-cn.json"), JSON.stringify(seed));
  if (overrides) fs.writeFileSync(path.join(dir, "tools", "zh-cn", "overrides.json"), JSON.stringify(overrides));
  if (dictionary) {
    fs.mkdirSync(path.join(dir, ".zh-cn"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".zh-cn", "dictionary.json"), JSON.stringify(dictionary));
  }
  return dir;
}

function sandboxWithDist(options) {
  const dir = sandbox(options);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "dist", "index.html"),
    '<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /></head>\n  <body><div id="root"></div></body>\n</html>\n',
  );
  return dir;
}

test("hand overrides win over the working dictionary, and leave the keep list", () => {
  const dir = sandbox({
    seed: { version: 1, entries: { Cancel: "取消", Keep: "Keep" }, patterns: {}, kept: { Keep: 1 } },
    dictionary: { entries: { Cancel: "取消X", Keep: "Keep" }, patterns: {}, kept: { Keep: 1 } },
    overrides: { Cancel: "取消", Keep: "保留", "Open {0}": "打开 {0}" },
  });

  const dictionary = loadDictionary(dir);
  assert.equal(dictionary.source, path.join(".zh-cn", "dictionary.json"), "working dictionary must win over the seed");
  assert.equal(dictionary.entries.Cancel, "取消", "an override must beat the model output");
  assert.equal(dictionary.entries.Keep, "保留");
  assert.equal(dictionary.patterns["Open {0}"], "打开 {0}", "a {0} override must land in the pattern table");
  assert.equal(dictionary.kept.Keep, 0, "a hand-fixed string leaves the keep-English list");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an override reaches dist even when no dictionary was produced", () => {
  const dir = sandboxWithDist({
    seed: { version: 1, entries: { Cancel: "取消", MonoCode: "MonoCode" }, patterns: {}, kept: { MonoCode: 1 } },
    overrides: { "GitLab URL": "GitLab 地址" },
  });

  postBuild(dir);
  const script = fs.readFileSync(path.join(dir, "dist", "zh-cn.js"), "utf8");
  assert.match(script, /GitLab 地址/, "the hand-fixed string must be injected without any translate run");
  assert.doesNotMatch(script, /"MonoCode"/, "a kept string must stay out of the runtime table");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("drops kept strings, identity and empty mappings", () => {
  const kept = { MonoCode: 1 };
  const table = { MonoCode: "MonoCode", Cancel: "Cancel", Blank: " ", Real: "取消" };
  assert.deepEqual(dropKept(table, kept), { Real: "取消" });
});

test("resolves to nothing when neither dictionary file exists", () => {
  const dir = sandbox();
  const dictionary = loadDictionary(dir);
  assert.equal(dictionary.source, null);
  assert.deepEqual(Object.keys(dictionary.entries), []);
  fs.rmSync(dir, { recursive: true, force: true });
});