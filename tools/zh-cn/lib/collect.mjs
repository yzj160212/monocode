/**
 * Collects every string the Chinese layer may need to translate.
 *
 * Three buckets, because they are applied differently:
 *   exact    - a literal that is rendered verbatim (JSX text, UI attributes,
 *              known props, and prose-looking literals such as error messages)
 *   patterns - a template literal with interpolations, keyed by "{0} of {1}"
 *   menu     - native macOS menu copy handled by patch-native.mjs
 *
 * Nothing here mutates source files: translation is applied to the built DOM
 * and to the native menu at runtime, so upstream refactors never conflict.
 */
import { cssTokenRatio, looksLikeUiText } from "./filters.mjs";

export const UI_ATTRS = new Set([
  "title", "placeholder", "aria-label", "ariaLabel", "alt", "label", "description",
  "tooltip", "hint", "heading", "subtitle", "emptyText", "confirmLabel", "cancelLabel",
  "emptyLabel", "noResultsText", "searchPlaceholder", "promptText", "helperText",
  "aria-description", "summary", "caption",
]);

export const UI_PROPS = new Set([
  "label", "title", "description", "placeholder", "message", "text", "heading",
  "subtitle", "tooltip", "hint", "emptyText", "confirmLabel", "cancelLabel",
  "detail", "summary", "caption", "prompt", "emptyLabel", "helperText", "noResultsText",
  "searchPlaceholder", "promptText", "ariaLabel", "ariaDescription",
]);

const PLACEHOLDER = "\u0000";

/** A template whose literals are CSS values, units or transform helpers. */
const LOOKS_LIKE_CSS_VALUE = /^\s*(?:-?\d*\.?\d*\s*(?:px|rem|em|%|vh|vw|fr|deg|ms|s)?\s*)+$/i;

/** CSS units and function names that must never count as words. */
const CSS_UNITS = new Set(["px", "rem", "em", "vw", "vh", "fr", "deg", "ms", "s", "pct"]);
const PLACEHOLDER_TEXT_RX = /\{\d+\}/g;

/**
 * Template literal -> `{0} of {1}` style pattern, or null when it is layout.
 *
 * Deciding per segment is unreliable: `not found` reads like prose, and a
 * segment alone cannot tell copy from a fragment. The whole literal is judged
 * instead — copy is mostly words, layout is mostly Tailwind utilities.
 */
function templatePattern(node) {
  let text = node.head.text;
  for (const span of node.templateSpans) text += PLACEHOLDER + span.literal.text;
  if (!/[A-Za-z]{2,}/.test(text)) return null;
  const segments = text.split(PLACEHOLDER).map((segment) => segment.trim()).filter(Boolean);
  const literal = segments.join(" ");
  if (!literal) return null;
  // Semicolons are ordinary prose ("in the background; ⌘Return …"), and
  // braces are already rejected by looksLikeUiText below.
  if (cssTokenRatio(literal) > 0.4) return null;
  // CSS values and transform helpers: `{0}px`, `translateY({0}px)`, `{0} %`.
  if (LOOKS_LIKE_CSS_VALUE.test(literal)) return null;
  // Transform / filter / calc helpers wrap their arguments in parentheses.
  if (/^(?:-?[a-z]+|[a-z]\w*)\(/i.test(literal)) return null;
  // Scheme-like fragments (`file:{0}`, `mono:{0}`, `data:{0};base64,{1}`,
  // `--port={0}`, `[data-x="{0}"]`) are protocol plumbing, never copy.
  if (/^(?:[a-z][a-z0-9+.-]*:\{|--|\[)/.test(literal)) return null;
  // Key composition (`commit:{0}:{1}`, `hunk:{0}:{1}`, `data:{0};base64,{1}`).
  // A real sentence has words between the colons, these do not.
  if (/^[a-z][a-z0-9]*:/.test(literal) && !/\s[A-Za-z]{3,}/.test(literal)) return null;
  // A single token ending in a colon or comma is a prefix fragment
  // (`mono:{0}`, `name: {0}`), not a sentence; trailing punctuation such as
  // "available." is prose.
  const tokens = literal.split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && /[:;,=]$/.test(literal)) return null;
  // Prompt scaffolding: XML-wrapped context blocks sent to a model.
  if (/^\s*</.test(literal)) return null;
  // Generated identifiers (`field_{0}`, `mc_turn_{0}`, `monocode_{0}`).
  if (/^[a-z][a-z0-9_]*_$/.test(literal) || /^[a-z][a-z0-9_]*_\s/.test(literal)) return null;
  if (literal.split(/\s+/).length === 1 && literal.includes("_")) return null;
  // A single short token is a unit, not copy.
  if (literal.replace(/[^A-Za-z]/g, "").length < 4) return null;
  // A lone trailing word is still copy when the sentence is carried by the
  // interpolation: `${n} ${plural} available.` yields the segment "available.".
  // Require real words (not CSS units) and no markers.
  if (!looksLikeUiText(literal, { maxLength: 700 })) {
    // Interpolations can carry the sentence (`${n} ${plural} available.`), so a
    // short plain-word tail still counts. CSS units and transforms do not.
    const words = literal.replace(/[^A-Za-z\s]/g, "").trim().split(/\s+/).filter(Boolean);
    const plain = words.length > 0 && words.length <= 3 &&
      words.every((word) => word.length >= 4 && !CSS_UNITS.has(word));
    if (!plain) return null;
    // Every segment must be created by the template itself, not a function
    // call: `translateY({0}px)` has one segment only and no words.
    const segmentsWithWords = segments.filter((segment) => /[A-Za-z]{4,}/.test(segment));
    if (segmentsWithWords.length === 0) return null;
    if (/[A-Z]/.test(literal)) return null;
  }
  let index = 0;
  return text.replace(/\u0000/g, () => `{${index++}}`);
}

/** Literals that read like copy but are not attached to a UI slot. */
function isProseLiteral(text) {
  // Help text and settings descriptions routinely run past 400 characters.
  if (!looksLikeUiText(text, { maxLength: 700 })) return false;
  return true;
}

export function collectAll(ts, sourceFile, code) {
  const exact = new Map(); // text -> kinds Set
  const patterns = new Map(); // pattern -> kinds Set

  const addExact = (text, kind) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    // JSX text and UI attributes are rendered by definition, so a bare word is
    // copy there. A loose literal must look like a sentence: "growth" beside
    // `status === "growth"` is an enum, not a label.
    const sentenceOnly = kind === "literal";
    if (!looksLikeUiText(normalized, {
      maxLength: sentenceOnly ? 700 : 600,
      requireSentence: sentenceOnly,
    })) return;
    if (!exact.has(normalized)) exact.set(normalized, new Set());
    exact.get(normalized).add(kind);
  };
  const addPattern = (text, kind) => {
    if (!patterns.has(text)) patterns.set(text, new Set());
    patterns.get(text).add(kind);
  };

  const stringOf = (node) => {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return undefined;
  };

  /**
   * Every value an expression can actually produce.
   *
   * UI slots are often `available ? \`\${n} models available.\` : hint()`, and
   * both branches are copy. Descending through ternaries, `&&` and `??` is the
   * difference between translating that description and leaving it English.
   */
  const leaves = (node, depth = 0) => {
    if (!node || depth > 6) return [];
    const current = unwrap(node);
    if (!current) return [];
    if (ts.isConditionalExpression(current)) {
      return [...leaves(current.whenTrue, depth + 1), ...leaves(current.whenFalse, depth + 1)];
    }
    if (ts.isBinaryExpression(current) && current.operatorToken) {
      const kind = current.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return [...leaves(current.left, depth + 1), ...leaves(current.right, depth + 1)];
      }
    }
    if (ts.isCallExpression(current)) return [];
    return [current];
  };

  /** Records a UI value: literal, template pattern, or nothing. */
  const addSlotValue = (expression, kind) => {
    for (const leaf of leaves(expression)) {
      const text = stringOf(leaf);
      if (text !== undefined) {
        addExact(text, kind);
        continue;
      }
      if (ts.isTemplateExpression(leaf)) {
        const pattern = templatePattern(leaf);
        if (pattern) addPattern(pattern, kind);
      }
    }
  };

  const unwrap = (node) => {
    let current = node;
    while (
      current &&
      (ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current)) ||
        ts.isNonNullExpression(current) ||
        // `description={"text"}` and `description={`a ${b} c`}` both wrap the
        // real expression in a JSX container.
        ts.isJsxExpression(current))
    ) {
      current = current.expression;
    }
    return current;
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      addExact(node.getText(sourceFile), "jsx");
    } else if (ts.isJsxAttribute(node) && node.name && ts.isIdentifier(node.name) && UI_ATTRS.has(node.name.text)) {
      addSlotValue(node.initializer, "attr");
    } else if (ts.isJsxExpression(node)) {
      const parent = node.parent;
      const inSlot =
        ts.isJsxElement(parent) ||
        ts.isJsxFragment(parent) ||
        (ts.isJsxAttribute(parent) && parent.name && ts.isIdentifier(parent.name) && UI_ATTRS.has(parent.name.text));
      if (inSlot) addSlotValue(node.expression, "jsexpr");
    } else if (ts.isPropertyAssignment(node) && node.name) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      if (key && UI_PROPS.has(key)) addSlotValue(node.initializer, "prop");
    } else if (ts.isTemplateExpression(node)) {
      if (!(node.parent && ts.isTaggedTemplateExpression(node.parent))) {
        const pattern = templatePattern(node);
        if (pattern) addPattern(pattern, "template");
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.parent && ts.isImportDeclaration(node.parent)) return;
      if (isProseLiteral(node.text)) addExact(node.text, "literal");
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { exact, patterns };
}
