// Regression guard for strings users reported as still English.
//
// Each entry is real copy from the app: if any of these stops translating, the
// pipeline regressed either in extraction (filters / AST walk) or in the
// dictionary. Sources are copied verbatim from src/**; `npm run zh-cn:audit`
// explains where a miss comes from.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Window } from "happy-dom";
import { renderRuntimeScript } from "./lib/runtime-script.mjs";

/**
 * The dictionary the build used. `.zh-cn/` is generated, so fall back to the
 * committed seed when a fresh clone runs the tests before any translation.
 */
function loadDictionary() {
  const root = new URL("../../", import.meta.url);
  for (const candidate of [".zh-cn/dictionary.json", "tools/zh-cn/seed.zh-cn.json"]) {
    const file = new URL(candidate, root);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  throw new Error("no dictionary found: run tools/zh-cn/translate.mjs first");
}

const dictionary = loadDictionary();

/** The exact payload the build injects into dist/zh-cn.js. */
function runtimePayload() {
  const kept = dictionary.kept ?? {};
  const drop = (table) =>
    Object.fromEntries(
      Object.entries(table ?? {}).filter(
        ([source, target]) => kept[source] !== 1 && typeof target === "string" && target && target !== source,
      ),
    );
  return { entries: drop(dictionary.entries), patterns: drop(dictionary.patterns) };
}

const SAMPLE = [
  // Settings → General → quick composer shortcut
  "Press ⇧Space in any app to float a prompt over it and start a session without switching to MonoCode. Change the shortcut in Keybindings. Return starts it in the background; ⌘Return starts it and brings the session forward.",
  // Appearance → diff colours
  "Colors for added and removed lines. Colorblind and High contrast use blue and orange instead of green and red; High contrast adds stronger tints and text.",
  // General → zoom
  "Zoom the whole interface. You can also use Ctrl+=, Ctrl+-, and Ctrl+0 (Cmd on macOS).",
  // Providers header
  "A provider is listed as installed once its CLI is found on your PATH. Uninstalled CLIs stay listed but are left out of the model picker, as are installed ones with Show in picker off. The model beside a provider is what its new conversations start with; Use by default picks the provider itself. CLI paths are global for MonoCode and apply to every project.",
  // Provider availability hint (template: name + install command)
  "Codex CLI not found. Install it, or restart MonoCode if it is already installed.",
  "9 models available.",
  "Grok Build CLI not found (`curl -fsSL https://x.ai/cli/install.sh | bash`). Install it, or restart MonoCode if it is already installed.",
  // Sessions → idle harness lifetime
  "A finished conversation keeps its agent CLI running for a few minutes, so a follow-up starts instantly. Each one can hold a few hundred MB of memory. Past this many, the one idle longest stops early; it resumes on your next message after a short restart. Choose None on a machine short on memory.",
  // Hooks
  "Run the hooks configured in your settings.json files — PreToolUse command rewrites, blocks, notifications, and the rest — just as the Claude Code CLI would. Turn this off if a hook is misbehaving and you need the session back. Takes effect on the next turn.",
  // Integrations
  "Connect GitLab.com or a self-managed GitLab instance. Use a personal access token with API access; the token is stored locally and Disconnect deletes it.",
  "The iPhone app currently requires a TestFlight invitation.",
  // Short labels that used to be filtered out
  "Delete",
  "Catch-up window for missed runs",
  "Go to File (type > for commands)",
  // Second round: sentences whose shape tripped a heuristic.
  "Your machines",
  "Run agents on another computer and return to them from your laptop. The host keeps working when you close MonoCode here.",
  "Configured servers for the selected project and your provider accounts.",
  "Check on projects and conversations from the MonoCode mobile app. Your phone connects straight to this desktop.",
  "Antigravity session stopped during startup",
  "Claude usage unavailable",
  "Missing Linear issue",
  "Unknown inbox item",
  "Build approved plan",
  "Devin session stopped",
  "OpenCode session failed.",
  "(Empty. Nothing has been remembered yet.)",
  "(optional)",
];

test("template labels translate without being read as a protocol key or shortcut", () => {
  const window = new Window({ url: "http://localhost/" });
  const cases = [
    "Model: gpt-4.1",
    "Thinking: high effort",
    "Workspace: my-app",
    "Remove main from this desktop?",
    "Show 3 more annotations",
  ];
  const paragraphs = cases.map((copy) => {
    const p = window.document.createElement("p");
    p.textContent = copy;
    window.document.body.appendChild(p);
    return p;
  });

  window.eval(renderRuntimeScript(runtimePayload(), { hash: "test" }));

  cases.forEach((source, index) => {
    const rendered = paragraphs[index].textContent.trim();
    assert.match(rendered, /[\u4e00-\u9fa5]/, `no Chinese for: ${source}`);
    // The interpolated value must survive the rewrite.
    const value = source.split(/[:?]/)[1] ?? source.split(" ")[1];
    assert.ok(rendered.includes(value.trim().split(" ")[0]), `lost value in: ${rendered}`);
  });
});

test("a sentence split across sibling text nodes still translates", () => {
  const window = new Window({ url: "http://localhost/" });
  const p = window.document.createElement("p");
  p.appendChild(window.document.createTextNode("Say hello to "));
  p.appendChild(window.document.createTextNode("Mono"));
  p.appendChild(window.document.createTextNode(", ask a question, or hand over some work."));
  window.document.body.appendChild(p);

  window.eval(renderRuntimeScript(runtimePayload(), { hash: "test" }));

  assert.match(p.textContent, /[\u4e00-\u9fa5]/, `no Chinese: ${p.textContent}`);
  assert.match(p.textContent, /Mono/, "interpolated value must survive");
});

test("previously missed strings now translate", () => {
  const window = new Window({ url: "http://localhost/" });
  // Assign text per node: an HTML round trip mangles ">" inside copy.
  const paragraphs = SAMPLE.map((sample) => {
    const p = window.document.createElement("p");
    p.textContent = sample;
    window.document.body.appendChild(p);
    return p;
  });

  window.eval(renderRuntimeScript(runtimePayload(), { hash: "test" }));

  SAMPLE.forEach((source, index) => {
    const rendered = paragraphs[index].textContent.trim();
    assert.notEqual(rendered, source, `still English: ${source.slice(0, 60)}`);
    assert.match(rendered, /[\u4e00-\u9fa5]/, `no Chinese: ${source.slice(0, 60)}`);
  });
});

test("placeholders survive the rewrite", () => {
  const window = new Window({ url: "http://localhost/" });
  const p = window.document.createElement("p");
  p.textContent = "Delete main?";
  window.document.body.appendChild(p);

  window.eval(renderRuntimeScript(runtimePayload(), { hash: "test" }));

  // The pattern is `Delete {0}?`, so the interpolated name must remain.
  assert.match(p.textContent.trim(), /main/);
  assert.notEqual(p.textContent.trim(), "Delete main?");
});

test("dictionary covers every extracted string", () => {
  // The seed carries no `missing` list; a real run always does.
  if (dictionary.missing === undefined) return;
  assert.deepEqual(dictionary.missing, [], "dictionary reports untranslated strings");
});
