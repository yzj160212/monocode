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
import { cssTokenRatio, decodeEntities, isCssToken, looksLikeUiText } from "./filters.mjs";

export const UI_ATTRS = new Set([
  "title", "placeholder", "aria-label", "ariaLabel", "alt", "label", "description",
  "tooltip", "hint", "heading", "subtitle", "emptyText", "confirmLabel", "cancelLabel",
  "emptyLabel", "noResultsText", "searchPlaceholder", "promptText", "helperText",
  "aria-description", "summary", "caption",
]);

/**
 * Search-index fields. These strings are never rendered: they only feed the
 * settings search. Their shape (a run of lowercase keywords) is what an earlier
 * heuristic used to guess "this is not copy", which also swallowed real
 * sentences such as "does not support manual compaction".
 */
export const INDEX_PROPS = new Set(["keywords", "searchTerms", "searchKeywords", "indexTerms"]);

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
  // A template whose only literal is `Label:` is ambiguous: "Model: {0}" is a
  // UI label, "Ultrathink:\n{0}" is a model instruction marker. Both
  // look identical here, so the marker is listed in keep.txt instead — this
  // rule only rejects ones with no letters after the colon at all.
  if (!literal) return null;
  // Layout strings are all utilities; copy is not. A ratio alone misfires on
  // short literals — "sign-in required" is 50% "CSS-ish" by token shape — so
  // require every token to look like a utility before trusting the ratio.
  const literalTokens = literal.split(/\s+/).filter(Boolean);
  const allUtilities = literalTokens.length > 0 && literalTokens.every(isCssToken);
  if (allUtilities || (literalTokens.length >= 4 && cssTokenRatio(literal) > 0.4)) return null;
  // CSS values and transform helpers: `{0}px`, `translateY({0}px)`, `{0} %`,
  // and grid shorthand such as `{0}px minmax(0, 1fr)`.
  if (LOOKS_LIKE_CSS_VALUE.test(literal)) return null;
  if (/minmax\(|repeat\(|calc\(/.test(literal)) return null;
  // Transform / filter / calc helpers wrap their arguments in parentheses.
  if (/^(?:-?[a-z]+|[a-z]\w*)\(/i.test(literal)) return null;
  // Scheme-like fragments (`file:{0}`, `mono:{0}`, `data:{0};base64,{1}`,
  // `--port={0}`, `[data-x="{0}"]`) are protocol plumbing, never copy.
  if (/^(?:[a-z][a-z0-9+.-]*:\{|--|\[)/.test(literal)) return null;
  // Key composition (`commit:{0}:{1}`, `hunk:{0}:{1}`, `data:{0};base64,{1}`).
  // A real sentence has words between the colons, these do not.
  if (/^[a-z][a-z0-9]*:/.test(literal) && !/\s[A-Za-z]{3,}/.test(literal)) return null;
  // A single lowercase token ending in a colon/comma/equals is protocol
  // plumbing (`mono:`, `remote:`, `?v=`, `session-changes:`). A capitalised
  // token is a label prefix and very much copy ("Model: {0}", "Checks: {0}").
  const tokens = literal.split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && /[:;,=]$/.test(literal) && /^[a-z?]/.test(literal)) return null;
  // Storage keys assembled from slots (`{0}:message:{1}:{2}`,
  // `session-changes:{0}:{1}`, `monocode.remote-command.v1:{0}:`) are
  // identifiers. A sentence keeps whole words separated by spaces, and its
  // separators are surrounded by prose ("Could not {0}: {1}").
  const looksLikeKey = (segment) => {
    if (/\s/.test(segment)) return false; // "no local file path" -> prose
    if (/^(?:[a-z][\w-]*\.)+[\w.-]+:?$/i.test(segment)) return true; // dotted ns
    // Separators with no surrounding prose: ":" , ":message:" , "label:".
    if (/^[:.,;=]+$/.test(segment)) return true;
    if (/^:[a-z][\w-]*:\s*$/i.test(segment)) return true;
    return /^-?[a-z][\w-]*:\s*$/.test(segment);
  };
  if (segments.every(looksLikeKey)) return null;
  // Prompt scaffolding: XML-wrapped context blocks sent to a model, and
  // instruction prefixes such as `Ultrathink:\n{0}`.
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
    // Decode entities first: JSX text `&apos;s` renders as `'s`, so the
    // dictionary key must match what React puts in the DOM.
    const normalized = decodeEntities(text).replace(/\s+/g, " ").trim();
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

  /** Whether this literal is an argument of split()/join()/replace(). */
  const isListDelimiter = (node) => {
    let current = node.parent;
    while (current && (ts.isAsExpression(current) || ts.isParenthesizedExpression(current))) current = current.parent;
    if (!current) return false;
    const call = ts.isCallExpression(current) ? current : ts.isCallExpression(current.parent) ? current.parent : null;
    if (!call || !ts.isPropertyAccessExpression(call.expression)) return false;
    const name = call.expression.name.text;
    return name === "split" || name === "join" || name === "replace" || name === "replaceAll";
  };

  /**
   * A string compared with `===`/`!==` or used as a `case` test is a value the
   * program matches on, not copy that reaches the screen. This is the only
   * reliable way to tell `key === "Tab"` from the label "Tab".
   */
  const isEnumOperand = (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isCaseClause(parent)) return true;
    if (ts.isBinaryExpression(parent) && parent.operatorToken) {
      const kind = parent.operatorToken.kind;
      return (
        kind === ts.SyntaxKind.EqualsEqualsToken ||
        kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      );
    }
    return false;
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

  /**
   * A sentence split across a JSX child expression:
   *   Select the activity on one of {name}&apos;s messages to see each step.
   * React renders two text nodes, so the runtime cannot match either half.
   * Emit a pattern keyed on the concatenation, which the runtime path handles.
   */
  const addSplitSentence = (children) => {
    for (let i = 0; i + 2 < children.length; i += 1) {
      const head = children[i];
      const middle = children[i + 1];
      const tail = children[i + 2];
      if (!ts.isJsxText(head) || !ts.isJsxExpression(middle) || !ts.isJsxText(tail)) continue;
      // Only a value expression may sit between the halves; a nested element
      // (icon, link) would break the text-node assumption.
      if (!middle.expression || ts.isJsxElement(middle.expression) || ts.isJsxFragment(middle.expression)) continue;

      const before = decodeEntities(head.text).replace(/\s+/g, " ").trim();
      const after = decodeEntities(tail.text).replace(/\s+/g, " ").trim();
      if (!before || !after) continue;
      if (!/[a-z]{3,}/.test(before) || !/[a-z]{3,}/.test(after)) continue;

      // The rendered text joins them with a space unless one side already ends
      // or starts with punctuation.
      const needsSpaceBefore = !/[\s(\[{]$/.test(before);
      const needsSpaceAfter = !/^[\s.,;:!?)\]}]/.test(after);
      const pattern = `${before}${needsSpaceBefore ? " " : ""}{0}${needsSpaceAfter ? " " : ""}${after}`;
      if (!looksLikeUiText(pattern, { maxLength: 700 })) continue;
      addPattern(pattern, "split");
    }
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
    } else if (ts.isJsxElement(node)) {
      addSplitSentence([...node.children]);
      addSlotValue === undefined; // keep lint quiet about the helper above
    } else if (ts.isPropertyAssignment(node) && node.name) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      // Skip search-index fields: they are not rendered anywhere.
      if (key && INDEX_PROPS.has(key)) return;
      if (key && UI_PROPS.has(key)) addSlotValue(node.initializer, "prop");
    } else if (ts.isTemplateExpression(node)) {
      if (!(node.parent && ts.isTaggedTemplateExpression(node.parent))) {
        const pattern = templatePattern(node);
        if (pattern) addPattern(pattern, "template");
      }
    } else if (isEnumOperand(node)) {
      // Matched against, never rendered.
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.parent && ts.isImportDeclaration(node.parent)) return;
      // A literal handed to split()/join() is a delimiter or a word list, never
      // rendered: STOPWORDS = "the and for ...".split(" ").
      if (isListDelimiter(node)) return;
      if (isProseLiteral(node.text)) addExact(node.text, "literal");
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { exact, patterns };
}
