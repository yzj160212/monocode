// Guards the extractor's promise: rendered copy is collected, code is not.
// Run with `node --test tools/zh-cn/`.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { collectAll } from "./lib/collect.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function collect(code) {
  const sourceFile = ts.createSourceFile("sample.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return collectAll(ts, sourceFile, code);
}

const keys = (map) => [...map.keys()];

test("collects JSX text, UI attributes and known props", () => {
  const { exact } = collect(`
    const A = () => (
      <div title="Project settings" aria-label="Open project">
        <span>Cancel</span>
        <Row description="Colors for added and removed lines. Colorblind mode uses blue and orange." />
        <Dialog label={"Remove project?"} />
      </div>
    );
  `);
  const found = keys(exact);
  for (const expected of [
    "Cancel",
    "Project settings",
    "Open project",
    "Colors for added and removed lines. Colorblind mode uses blue and orange.",
    "Remove project?",
  ]) {
    assert.ok(found.includes(expected), `missing: ${expected}`);
  }
});

test("keeps layout, identifiers and key names out", () => {
  const { exact } = collect(`
    const cls = "min-w-0 flex-1 items-center gap-2";
    const id = "session.providerBound";
    const key = "Enter";
    const route = "/api/sessions";
    const mime = "image/svg+xml";
    const fmt = "HH:mm";
    const A = () => <div className={cls} data-id={id} data-key={key} />;
  `);
  const found = keys(exact);
  for (const rejected of ["min-w-0 flex-1 items-center gap-2", "session.providerBound", "Enter", "/api/sessions", "image/svg+xml", "HH:mm"]) {
    assert.ok(!found.includes(rejected), `should be excluded: ${rejected}`);
  }
});

test("turns templates into {0} patterns but skips class-name templates", () => {
  const { patterns } = collect(`
    const a = \`Delete \${name}?\`;
    const b = \`flex h-9 w-full items-center \${extra}\`;
    const c = \`\${label} not found\${how}. Install it, or restart MonoCode if it is already installed.\`;
    const Row = () => <Row description={\`Press \${key} in any app to float a prompt over it.\`} />;
  `);
  const found = keys(patterns);
  assert.ok(found.includes("Delete {0}?"), "simple template");
  assert.ok(found.some((p) => p.startsWith("{0} not found{1}.")), "two-placeholder prose");
  assert.ok(found.some((p) => p.startsWith("Press {0} in any app")), "template inside a UI attribute");
  assert.ok(!found.some((p) => p.includes("flex h-9")), "class-name template must be skipped");
});

test("collects prose from loose literals but not enum values", () => {
  const { exact } = collect(`
    const t = "The iPhone app currently requires a TestFlight invitation.";
    const status = "running";
    const mode = "growth";
  `);
  const found = keys(exact);
  assert.ok(found.includes("The iPhone app currently requires a TestFlight invitation."));
  assert.ok(!found.includes("running"), "enum value");
  assert.ok(!found.includes("growth"), "enum value");
});
