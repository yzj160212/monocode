/**
 * Decides whether a string is UI copy.
 *
 * The webview is a dense React + Tailwind app, so most string literals are
 * class lists, identifiers, key names or selectors. Only strings that survive
 * these rules are offered to the translator and stored in the dictionary.
 *
 * The rules are ordered cheapest-first and each one exists because a specific
 * false positive or false negative was observed in this codebase.
 */

/** Anything matching one of these is never UI copy. */
const NON_PROSE = [
  /^[\s\d\p{P}\p{S}]+$/u, // punctuation or numbers only
  /^(?:https?:|file:|mailto:|data:|\/|\.\/|\.\.\/)/, // urls and paths
  /^(?=[a-z0-9_.:/@-]*[_.:/@0-9])[a-z0-9_.:/@-]+$/, // identifiers, slugs, commands (need a separator or digit)
  /^[A-Z][A-Z0-9_]+$/, // CONSTANTS
  /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/, // camelCase
  /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/, // kebab / snake / dotted
  // A keyboard chord: modifier(s) joined by "+" and a single key. Anchored to
  // the whole string so "Command Palette" (a real label) is not caught.
  /^(?:(?:Cmd|Ctrl|Alt|Option|Shift|Command|CmdOrCtrl|Super|Meta)\+)+[A-Za-z0-9[\]`=,\-./';\\]$/,
  /^[^\s]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|png|jpe?g|gif|svg|dmg|app|rs|toml|lock|sha256|txt|yml|yaml|mjs|cjs|exe|zip|plist|db)$/i,
  /^(?:rgb|hsl|var|url|data|calc|minmax|repeat|inset|circle|ellipse|polygon|color-mix)\(/i,
  /^[a-z-]*gradient\(/i, // linear/radial/conic gradients
  /^(?:monocode|tauri|vscode|window|app)\.[\w.]+$/,
  /\{\{|\}\}|\$\{|\{\s*\w+\s*\}/, // template placeholders
  /%[sd@]/,
  /^[a-z]{2,4}(?:-[A-Z][a-z]+)+$/, // BCP47 tags such as zh-CN
  /^&[a-z]+$/, // html entities
  /^::?[a-z-]/, // css selectors and pseudo elements
  /^--/, // css custom properties, CLI flags
  /^[\w-]+=[\w-]+$/, // key=value flags
  /^\[[a-z-]+\]/, // log prefixes such as [mobile]
  /^[A-Za-z]{1,4}(?:[:.\/-][A-Za-z]{1,6})+\s*(?:[A-Za-z]{1,4}(?:[:.\/-][A-Za-z]{1,6})+)?$/, // date/time formats: HH:mm, yyyy-MM-dd HH:mm
  /^\W*$/, // symbols only
  /^[[\]{]/, // selectors, css blocks
  /^"/, // strings that are themselves quoted text
  /\\/, // escapes leaked from source literals
  /^\s*[.#][\w-]+\s*$/, // css selectors
  /^[.!\/](?!\s)[^\s]/, // selectors, negated expressions, paths
  /&&|\|\||=>|===|!==/, // code expressions
  /^-\s/, // yaml / markdown list scaffolding
  /^[Mm]\d/, // svg path data
  /^[~$@]|^\.\//, // paths and identifiers: ~/.agents/skills, ./src
  /^[\w+-]+\/[\w+./-]+$/, // mime types and protocol paths: image/svg+xml
  /,.*monospace|,.*sans-serif/, // font stacks
  /\b(?:Emoji|monospace|sans-serif)\.homepage\b/, // package identifiers
  /^(?:color-mix|color|hsl|rgb)\(|\(in srgb,/, // colour functions
  /^</, // markup: <svg xmlns=...>
  /\bxmlns=/, // inline svg markup
  /^(?:curl|npm|npx|node|git|brew|pip|sudo|cargo|sh|bash)\s/, // shell commands
  // Remaining CSS shapes: colours, value shorthands, transforms, selectors.
  /#[0-9a-f]{3,8}\b/i, // hex colours
  /(?:^|\s)(?:\d+(?:\.\d+)?(?:px|rem|em|%)\s+solid|underline\s+wavy)\b/, // border / text-decoration
  /^(?:transform|transition|animation|filter)\s/, // style properties
  /^(?:translate|scale|rotate)[XYZ3d]*\(/, // transform helpers
  /@(?:min|max|container|sm|md|lg|xl|2xl)[-\[]/, // tailwind container queries
  /^diff --git/, // git output
  /^(?:irm|iwr|Invoke-WebRequest|choco|winget|apt|dnf|apk|snap)\s/, // other shell commands
  /^(?:button|input|textarea|select|div|span|svg|path|a|p|ul|li)\b[^a-z]*\[/, // selector lists
  // Validation messages for tool/automation schemas: they name a JSON field and
  // are only seen by a model or a log, never by a user.
  /^[a-z][\w.]*\s+(?:must be|should be|is required)\b/,
  // Prompt and log lines: a colon-label followed by a url.
  /^\w+:\s+https?:\/\//,
  /^&[:.\[]/, // nested css selectors
  /^(?:\s*(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while)\s+){6,}/, // rust keyword dumps
  // API validation messages are lowercase and terse ("before is not a turn ID").
  // Prose that merely contains these words starts with a capital.
  /^[a-z][^.!?]*\b(?:requires|must be|is not a)\b/,
  /\b(?:placement|SessionId|sessionId|turnID|DTO)\b/, // internal identifiers
  // Selector and class lists: `input, textarea, [contenteditable="true"]`.
  /^(?:[a-z]+|\[[^\]]*\])(?:\s*,\s*(?:[a-z]+|\[[^\]]*\])){2,}$/,
  /\b(?:input|textarea|select|contenteditable|hidden|aria-hidden)\b.*[,]/, // selector fragments
];

/** Template placeholders inside a pattern key. */
const PLACEHOLDER_TEXT = /\{\d+\}/g;

/**
 * Brand and protocol words the translator must leave in English, and that the
 * "did it really translate?" check discounts.
 */
export const KEEP = new Set([
  "MonoCode", "mono", "monos", "Monos", "Git", "GitHub", "GitLab", "Claude",
  "Claude Code", "Codex", "Cursor", "Grok", "OpenCode", "Antigravity", "Pi",
  "omp", "fx", "Hermes", "Devin", "Linear", "Jira", "Slack", "npm", "Node.js",
  "Rust", "Windows", "macOS", "Linux", "AppImage", "DMG", "JSON", "HTTP",
  "HTTPS", "SSH", "PTY", "MCP", "LLM", "API", "URL", "URI", "CLI", "TUI",
  "GUI", "OK", "ID", "UUID", "CPU", "RAM", "GPU", "PID", "ADO", "PAT",
]);

/**
 * Pure navigation key names.
 *
 * Deliberately excluded, because each is also ordinary UI copy:
 *   - editing keys (Delete, Backspace) are button verbs too
 *   - modifier names (Command, Shift) title table columns such as "Command"
 * Keyboard-only surfaces (kbd/pre/code) are skipped by the runtime layer, so
 * leaving them out costs nothing.
 */
const KEY_NAMES = /^(?:Enter|Return|Escape|Esc|Tab|Home|End|Page ?Up|Page ?Down|Arrow ?(?:Up|Down|Left|Right)|Space|Caps ?Lock|F\d{1,2})$/;

/** Tailwind's bare utility words, no scale or variant attached. */
const CSS_BARE = new Set([
  "flex", "grid", "block", "inline", "hidden", "contents", "absolute", "relative",
  "fixed", "sticky", "static", "truncate", "italic", "underline", "uppercase",
  "lowercase", "capitalize", "grow", "shrink", "border", "rounded", "shadow",
  "outline", "ring", "antialiased", "transition", "animate", "cursor", "select",
  "transform", "origin", "isolate", "container", "sr-only", "group", "peer",
  "wrap", "nowrap", "visible", "invisible",
]);

/** A utility always carries one of these markers. */
const CSS_MARKER = /[-:[\]./0-9]/;

/** HTML and SVG element names, for recognising tag filters and tag dumps. */
const HTML_TAGS = new Set(
  ("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr").split(" "),
);
const SVG_TAGS = new Set(
  ("g path circle rect line polyline polygon ellipse text tspan defs use mask pattern stop filter symbol").split(" "),
);

/** Whether one token is a Tailwind utility rather than an English word. */
export function isCssToken(token) {
  const bare = token.replace(/[.,!?;:]+$/, "");
  if (!bare) return false;
  if (CSS_BARE.has(bare)) return true;
  if (/[A-Z]/.test(bare)) return false;
  if (!CSS_MARKER.test(bare)) return false;
  return /^[a-z0-9\-:[\]./()%#!,_]+$/.test(bare);
}

/** Fraction of tokens that look like Tailwind utilities. */
export function cssTokenRatio(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  return tokens.filter(isCssToken).length / tokens.length;
}

/** Tailwind class lists, media queries, inline style fragments. */
function looksLikeCss(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // A capitalised word breaks the CSS read ("Catch-up window for missed runs").
  if (tokens.some((token) => /^[A-Z][a-z]{2,}$/.test(token) || /[A-Z]/.test(token.slice(1)))) return false;
  if (/^(?:@media|@supports)\b/.test(text)) return true;
  // "(no text)" is copy; "(min-width: 600px)" is a media feature query. The
  // colon (or comma) is what separates them — testing for "(" here would match
  // the wrapper itself and reject every parenthesised label.
  if (/^\(.*\)$/.test(text)) return /[:,]/.test(text);
  if (tokens.every((token) => CSS_BARE.has(token))) return true;
  // Numeric-only geometry: `-1px 0 0 0`.
  if (tokens.every((token) => /^(-?[\d.]+(?:px|rem|em|%|ms|s|fr|vh|vw)?,?|0)$/.test(token))) return true;
  const cssish = tokens.filter(isCssToken).length;
  if (cssish / tokens.length < 0.7) return false;
  // Class lists always carry a marker; plain lowercase words are prose.
  return tokens.some((token) => CSS_MARKER.test(token.replace(/[.,!?;:]+$/, "")));
}

/** A whitespace list of element names: a filter constant, never UI copy. */
function looksLikeTagList(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return false;
  return tokens.every((token) => HTML_TAGS.has(token) || SVG_TAGS.has(token));
}

/**
 * Lowercase words that appear as their own JSX text: rendered copy, not enum
 * values. Kept explicit rather than inferring from position so a value that is
 * both rendered and compared (`done`) is a conscious decision.
 */
const SINGLE_WORD_LABELS = new Set([
  "done", "session", "account", "accounts", "usage", "available", "running",
  "commit", "memory", "start", "release", "parallel", "main", "of", "at",
  "on", "by", "and", "or", "to", "in", "no", "yes", "off", "auto", "manual",
]);

/**
 * Keyboard-shortcut command ids: "App: Settings", "Tab: Close All".
 *
 * Tested against the neutralised string, where a placeholder is U+0000 and not
 * a letter: "Workspace: {0}" is a label, "Workspace: Settings" is an id.
 */
const COMMAND_ID = /^(?:App|Tab|Pane|Terminal|Editor|View|Window|File|Help|Tools|Sessions?|Settings|Provider|Agents?|Workspace|Monos?|Notes|Inbox|Search|Projects|Skills|Automations|Notifications):\s+[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*$/;

/** Git counters such as "Pull {0} commits from {1}" are copy. */
const GIT_COPY = /^(?:Pull|Push|Merge|Rebase|Fetch|Sync)\b/;

/**
 * @param {string} raw
 * @param {{maxLength?: number, requireSentence?: boolean}} options
 *   requireSentence: only accept phrase-shaped copy (used for literals outside
 *   known UI slots, where an enum value is more likely than a sentence).
 */
/** HTML entities that JSX decodes before the text reaches the DOM. */
const ENTITIES = { "&apos;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };

/** Decode the entities a browser would, so keys match rendered text. */
export function decodeEntities(text) {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITIES)) out = out.split(entity).join(char);
  return out;
}

export function looksLikeUiText(raw, { maxLength = 220, requireSentence = false } = {}) {
  if (typeof raw !== "string") return false;
  // Placeholders are neutralised first so `{0}` never trips the code checks.
  const s = decodeEntities(raw.replace(PLACEHOLDER_TEXT, "\u0000")).replace(/\s+/g, " ").trim();
  const plain = s.replace(/\u0000/g, "X");
  if (plain.length < 2 || plain.length > maxLength) return false;
  if (!/[A-Za-z]{2,}/.test(plain)) return false;
  if (!/^[\x20-\x7E\u00A0-\uFFFF\u0000]*$/.test(s)) return false;
  // Braces mean code. Semicolons and equals signs are ordinary prose
  // ("Ctrl+=", "in the background; ⌘Return starts it").
  if (/[{}]/.test(s)) return false;
  if (KEY_NAMES.test(plain)) return false;
  if (looksLikeTagList(plain)) return false;
  for (const pattern of NON_PROSE) if (pattern.test(plain)) return false;
  if (COMMAND_ID.test(s)) return false;

  // "1 step", "3 commits": a count plus a unit is copy, not an enum value.
  if (/^\d+\s+[a-z]{2,}$/.test(plain)) return true;
  if (GIT_COPY.test(plain)) return true;

  // A bare lowercase word is ambiguous: an enum value the code compares, or a
  // rendered label. collect.mjs decides by position — literals outside a JSX
  // slot must pass requireSentence, so only rendered text gets through.
  if (/^[a-z]+$/.test(plain) && !KEEP.has(plain) && requireSentence) return false;
  if (/^[A-Z]{2,}$/.test(plain) && !KEEP.has(plain)) return false;
  if (looksLikeCss(plain)) return false;
  if (/^[\w.]+$/.test(plain) && plain.includes(".") && !plain.endsWith(".")) return false;

  if (requireSentence) {
    const words = plain.split(/\s+/);
    // A single bare word is an enum value far more often than a label, unless
    // it is a capitalised word ("Optional"), a known brand, or a parenthesised
    // annotation ("(optional)") — always rendered as copy.
    if (words.length === 1 && !KEEP.has(plain) && !/^[A-Z][a-z]{3,}$/.test(plain) && !/^\([a-z][a-z ']{2,}\)$/.test(plain)) {
      return false;
    }
    // Require a real word somewhere: rejects "-" and "a / b" scratch values.
    if (!/[a-z]{3,}/.test(plain)) return false;
    if (/\b(?:px|rem|em|ms|rgba?|hsla?|var|calc)\b/.test(plain)) return false;
    // Multi-word strings are accepted here. Shape heuristics ("all words are
    // short", "no function word") were tried and kept rejecting real labels
    // like "Claude usage unavailable"; search-index fields are excluded
    // structurally instead (see INDEX_PROPS in collect.mjs).
  }
  return true;
}

/** A pure class list / css fragment, used to classify pattern segments. */
export function looksLikeCssFragment(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (looksLikeCss(trimmed)) return true;
  return cssTokenRatio(trimmed) === 1;
}

export { NON_PROSE, KEY_NAMES, PLACEHOLDER_TEXT, CSS_BARE, COMMAND_ID };
