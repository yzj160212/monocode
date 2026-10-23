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
  // Real copy carries at least one phrase, not just an identifier.
  if (!/[A-Za-z]{3,}/.test(literal)) return null;
  if (!looksLikeUiText(literal, { maxLength: 700 })) return null;
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
      const value = unwrap(node.initializer);
      const text = stringOf(value);
      if (text !== undefined) {
        addExact(text, "attr");
      } else if (value && ts.isTemplateExpression(value)) {
        // A template inside description/title: the prose around the
        // interpolation is copy, so it needs a pattern entry.
        const pattern = templatePattern(value);
        if (pattern) addPattern(pattern, "attr");
      }
    } else if (ts.isJsxExpression(node)) {
      const expr = unwrap(node.expression);
      const text = stringOf(expr);
      if (text !== undefined) {
        const parent = node.parent;
        const inSlot =
          ts.isJsxElement(parent) || ts.isJsxFragment(parent) ||
          (ts.isJsxAttribute(parent) && parent.name && ts.isIdentifier(parent.name) && UI_ATTRS.has(parent.name.text));
        if (inSlot) addExact(text, "jsexpr");
      }
    } else if (ts.isPropertyAssignment(node) && node.name) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      if (key && UI_PROPS.has(key)) {
        const value = unwrap(node.initializer);
        const text = stringOf(value);
        if (text !== undefined) addExact(text, "prop");
        else if (value && ts.isTemplateExpression(value)) {
          const pattern = templatePattern(value);
          if (pattern) addPattern(pattern, "prop");
        }
      }
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
