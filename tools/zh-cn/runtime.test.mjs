// Guards the runtime layer's contract: rendered copy gets translated, user
// content and code surfaces never do. Run with `node --test tools/zh-cn/`.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { renderRuntimeScript } from "./lib/runtime-script.mjs";

const payload = {
  entries: {
    Cancel: "取消",
    Remove: "移除",
    Search: "搜索",
    "Open project": "打开项目",
    Settings: "设置",
  },
  patterns: {
    "Open {0}": "打开 {0}",
    "Delete {0}?": "删除 {0}？",
  },
};

function mount(html) {
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = html;
  window.eval(renderRuntimeScript(payload));
  return window.document;
}

test("translates text nodes and UI attributes", () => {
  const document = mount(`
    <button title="Remove">Cancel</button>
    <span aria-label="Search">Settings</span>
    <input placeholder="Search" />
  `);
  assert.equal(document.querySelector("button").textContent.trim(), "取消");
  assert.equal(document.querySelector("button").getAttribute("title"), "移除");
  assert.equal(document.querySelector("span").getAttribute("aria-label"), "搜索");
  assert.equal(document.querySelector("span").textContent.trim(), "设置");
  assert.equal(document.querySelector("input").getAttribute("placeholder"), "搜索");
});

test("applies {0} patterns while keeping the interpolated part", () => {
  const document = mount(`
    <p>Open settings.json</p>
    <p>Delete main?</p>
    <p>Open project</p>
  `);
  const [pattern, question, exact] = document.querySelectorAll("p");
  // Patterns are tried after exact entries, so copy that has a dedicated
  // translation keeps it, and templated copy keeps its interpolation.
  assert.equal(pattern.textContent.trim(), "打开 settings.json");
  assert.equal(question.textContent.trim(), "删除 main？");
  assert.equal(exact.textContent.trim(), "打开项目");
});

test("leaves code surfaces and user content alone", () => {
  const document = mount(`
    <pre>Cancel</pre>
    <code>Cancel</code>
    <kbd>Cancel</kbd>
    <div class="cm-content">Cancel</div>
    <div translate="no">Cancel</div>
    <p>Cancel</p>
  `);
  for (const tag of ["pre", "code", "kbd"]) {
    assert.equal(document.querySelector(tag).textContent.trim(), "Cancel", tag);
  }
  assert.equal(document.querySelector(".cm-content").textContent.trim(), "Cancel");
  assert.equal(document.querySelector('[translate="no"]').textContent.trim(), "Cancel");
  assert.equal(document.querySelector("p").textContent.trim(), "取消");
});

test("translates nodes that React adds after the first pass", async () => {
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = "<div id=root></div>";
  window.eval(renderRuntimeScript(payload));
  const added = window.document.createElement("span");
  added.textContent = "Cancel";
  window.document.getElementById("root").append(added);
  // MutationObserver callbacks run on the microtask queue.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(added.textContent, "取消");
});

test("marks the document as Chinese", () => {
  const document = mount("<p>Cancel</p>");
  assert.equal(document.documentElement.lang, "zh-CN");
});

test("ignores unknown copy", () => {
  const document = mount("<p>Completely unrelated sentence</p>");
  assert.equal(document.querySelector("p").textContent.trim(), "Completely unrelated sentence");
});
