// Cross-node sentence rewriting: React renders `text {expr} text` as siblings,
// so a pattern like "Select the activity on one of {0}'s messages…" could never
// match a single node. These cases are what users reported as untranslated.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { renderRuntimeScript } from "./lib/runtime-script.mjs";

const payload = {
  entries: {
    Cancel: "取消",
    "Remove from this desktop?": "从此桌面移除？",
    Running: "运行中",
  },
  patterns: {
    // Deliberately listed after the generic key: the runtime must pick the
    // more specific one regardless of insertion order.
    "Remove {0} from this desktop?": "从此桌面移除 {0}？",
    "{0} details": "{0} 详情",
    "{0} usage details": "{0} 用量详情",
    // `${live ? "Running" : "Ran"} ${n} subagents`: the first slot carries a
    // literal from the same expression, the second the count.
    "{0} {1} subagents": "{0} {1} 子智能体",
    "{0} {1} details": "{0} {1} 详情",
    "Say hello to {0}, ask a question, or hand over some work.": "向 {0} 打个招呼、提问，或交接一些工作。",
    "Select the activity on one of {0} 's messages to see each step it took.": "选择其中一个 {0} 的消息上的活动，查看它执行的每一步。",
    "Show {0} more annotations": "再显示 {0} 条注解",
  },
};

/**
 * React renders `text {expr} text` as three ADJACENT text nodes (the expression
 * becomes its own text node), which is the shape the runtime joins.
 */
function mountSplit(window, before, middle, after) {
  const p = window.document.createElement("p");
  p.appendChild(window.document.createTextNode(before));
  p.appendChild(window.document.createTextNode(middle));
  p.appendChild(window.document.createTextNode(after));
  window.document.body.appendChild(p);
  return p;
}

/** An element in the middle must NOT be joined: it may hold user content. */
function mountWithElementBetween(window, before, middle, after) {
  const p = window.document.createElement("p");
  p.appendChild(window.document.createTextNode(before));
  const strong = window.document.createElement("strong");
  strong.textContent = middle;
  p.appendChild(strong);
  p.appendChild(window.document.createTextNode(after));
  window.document.body.appendChild(p);
  return p;
}

test("rewrites a sentence React split across sibling text nodes", () => {
  const window = new Window({ url: "http://localhost/" });
  const p = mountSplit(window, "Select the activity on one of ", "agent-7", " 's messages to see each step it took.");
  window.eval(renderRuntimeScript(payload));

  const text = p.textContent;
  assert.match(text, /[\u4e00-\u9fa5]/, `no Chinese: ${text}`);
  assert.match(text, /agent-7/, "the interpolated value must survive");
  assert.doesNotMatch(text, /Select the activity/, "the English lead must be gone");
});

test("keeps the interpolated value when the split has punctuation", () => {
  const window = new Window({ url: "http://localhost/" });
  const p = mountSplit(window, "Say hello to ", "Mono", ", ask a question, or hand over some work.");
  window.eval(renderRuntimeScript(payload));

  assert.match(p.textContent, /Mono/);
  assert.match(p.textContent, /[\u4e00-\u9fa5]/);
});

test("leaves unrelated sibling text alone", () => {
  const window = new Window({ url: "http://localhost/" });
  const p = mountSplit(window, "Totally unrelated leading words ", "42", " and trailing words here.");
  window.eval(renderRuntimeScript(payload));

  assert.equal(p.textContent, "Totally unrelated leading words 42 and trailing words here.");
});

test("never joins across an element boundary", () => {
  const window = new Window({ url: "http://localhost/" });
  const p = mountWithElementBetween(window, "Say hello to ", "Mono", ", ask a question, or hand over some work.");
  window.eval(renderRuntimeScript(payload));

  // A child element means the middle is not plain interpolated text; leaving it
  // alone is safer than rewriting around content we did not author.
  assert.equal(p.textContent, "Say hello to Mono, ask a question, or hand over some work.");
});

test("a specific pattern wins over a generic one", () => {
  const window = new Window({ url: "http://localhost/" });
  const cases = {
    "Claude Code usage details": "Claude Code 用量详情",
    "Claude Code details": "Claude Code 详情",
  };
  const paragraphs = Object.keys(cases).map((copy) => {
    const p = window.document.createElement("p");
    p.textContent = copy;
    window.document.body.appendChild(p);
    return p;
  });
  window.eval(renderRuntimeScript(payload));
  Object.values(cases).forEach((expected, index) => {
    assert.equal(paragraphs[index].textContent, expected);
  });
});

test("a literal captured by a pattern slot is translated too", () => {
  const window = new Window({ url: "http://localhost/" });
  const p = window.document.createElement("p");
  // `${live ? "Running" : "Ran"} ${n} subagents` renders one text node whose
  // first word comes from a literal inside the interpolation.
  p.textContent = "Running 3 subagents";
  window.document.body.appendChild(p);
  window.eval(renderRuntimeScript(payload));

  assert.equal(p.textContent, "运行中 3 子智能体");
});

test("single text nodes still use exact and pattern paths", () => {
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = "";
  for (const copy of ["Cancel", "Remove from this desktop?", "Remove main from this desktop?"]) {
    const p = window.document.createElement("p");
    p.textContent = copy;
    window.document.body.appendChild(p);
  }
  window.eval(renderRuntimeScript(payload));
  const [exact, patternWithoutSlot, patternWithSlot] = [...window.document.querySelectorAll("p")].map((p) => p.textContent);
  assert.equal(exact, "取消");
  assert.equal(patternWithoutSlot, "从此桌面移除？");
  assert.equal(patternWithSlot, "从此桌面移除 main？");
});
