/**
 * Minimal LLM client for the translation step.
 *
 * Two wire formats are supported so the workflow works with GitHub Models
 * (OpenAI compatible), any OpenAI-compatible gateway, or an Anthropic-style
 * gateway:
 *   - ZH_TRANSLATE_API_KEY + ZH_TRANSLATE_BASE_URL + ZH_TRANSLATE_MODEL
 *   - ZH_TRANSLATE_FORMAT=openai|anthropic  (default: openai)
 *
 * With no explicit key, GitHub Models is used with GITHUB_TOKEN and the
 * `models: read` workflow permission.
 */

const DEFAULTS = {
  openai: {
    baseUrl: "https://models.github.ai/inference",
    model: "openai/gpt-4.1-mini",
    path: "/chat/completions",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    path: "/v1/messages",
  },
};

export function resolveProvider(env = process.env) {
  const format = (env.ZH_TRANSLATE_FORMAT || "openai").toLowerCase();
  if (format !== "openai" && format !== "anthropic") {
    throw new Error(`ZH_TRANSLATE_FORMAT must be openai or anthropic, got "${format}"`);
  }
  const base = DEFAULTS[format];
  const apiKey = env.ZH_TRANSLATE_API_KEY || env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!apiKey) {
    throw new Error(
      "No translation credentials. Set ZH_TRANSLATE_API_KEY, or expose GITHUB_TOKEN with `models: read`.",
    );
  }
  const baseUrl = (env.ZH_TRANSLATE_BASE_URL || base.baseUrl).replace(/\/+$/, "");
  const path = env.ZH_TRANSLATE_PATH || base.path;
  return {
    format,
    apiKey,
    baseUrl,
    url: `${baseUrl}${path}`,
    model: env.ZH_TRANSLATE_MODEL || base.model,
    maxTokens: Number(env.ZH_TRANSLATE_MAX_TOKENS || 4096),
    timeoutMs: Number(env.ZH_TRANSLATE_TIMEOUT_MS || 90_000),
  };
}

async function postJson(url, headers, body, { attempts = 4, timeoutMs = 90_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
        error.retryable = retryable;
        throw error;
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false && !(error instanceof SyntaxError);
      if (!retryable || attempt === attempts) break;
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      console.warn(`  retry ${attempt}/${attempts} in ${wait}ms: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** Returns the assistant's visible text for either wire format. */
function extractText(provider, payload) {
  if (provider.format === "anthropic") {
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    return blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  }
  return (payload.choices?.[0]?.message?.content ?? "").trim();
}

export async function complete(provider, { system, user, temperature = 0 }) {
  const body =
    provider.format === "anthropic"
      ? {
          model: provider.model,
          max_tokens: provider.maxTokens,
          temperature,
          system,
          messages: [{ role: "user", content: user }],
        }
      : {
          model: provider.model,
          max_tokens: provider.maxTokens,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        };
  const headers =
    provider.format === "anthropic"
      ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${provider.apiKey}` };
  const payload = await postJson(provider.url, headers, body, { timeoutMs: provider.timeoutMs });
  const text = extractText(provider, payload);
  if (!text) throw new Error("empty completion");
  return text;
}

/** Parses a JSON object out of an LLM reply that may be fenced or chatty. */
export function parseJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
  // Truncated replies have no closing brace; keep what came before the cut.
  const end = candidate.lastIndexOf("}");
  const body = end > start ? candidate.slice(start, end + 1) : candidate.slice(start);
  return lenientJson(body);
}

/**
 * Recovers the pairs the model did emit, even when the object is truncated or
 * a stray quote breaks it. A batch is worth keeping partial results: rerunning
 * only costs the strings that are still missing.
 */
function lenientJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const out = {};
    // "key": "value" with JSON-escaped strings.
    const re = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    for (const match of text.matchAll(re)) {
      try {
        out[JSON.parse(`"${match[1]}"`)] = JSON.parse(`"${match[2]}"`);
      } catch {
        /* skip malformed pair */
      }
    }
    if (Object.keys(out).length === 0) throw error;
    return out;
  }
}
