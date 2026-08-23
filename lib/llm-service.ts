// The private multimodel LLM service (llama.cpp, private networking).
// One place resolves its address so a rename never touches callers.
// LLM_SERVICE_URL is the current name; SUMMARIZER_URL is honored as a
// fallback so older deployments keep working.
export function llmBaseUrl(): string | undefined {
  return process.env.LLM_SERVICE_URL || process.env.SUMMARIZER_URL || undefined;
}

export function llmModelLabel(): string {
  return process.env.LLM_SERVICE_MODEL_LABEL || process.env.SUMMARIZER_MODEL_LABEL || 'unknown';
}

/** One text chat call against the service. Returns null when no service
 * is configured; throws on transport/HTTP failure so callers own their
 * retry semantics. */
export async function llmChat(opts: {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  temperature?: number;
}): Promise<string | null> {
  const baseUrl = llmBaseUrl();
  if (!baseUrl) return null;
  const { system, user, maxTokens, timeoutMs = 60_000, fetchFn = fetch, temperature = 0.3 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature,
      }),
    });
    if (!res.ok) throw new Error(`llm ${res.status}`);
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content?.trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One chat call whose output is grammar-constrained to the given JSON
 * schema (llama.cpp compiles it to a GBNF grammar — the model physically
 * cannot emit non-conforming text). cache_prompt keeps the static system
 * prefix in the KV cache so repeated calls skip re-processing it.
 * Returns null when no service is configured; throws on transport errors.
 */
export async function llmChatJson(opts: {
  system: string;
  user: string;
  schema: object;
  maxTokens: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  temperature?: number;
}): Promise<string | null> {
  const baseUrl = llmBaseUrl();
  if (!baseUrl) return null;
  const { system, user, schema, maxTokens, timeoutMs = 30_000, fetchFn = fetch, temperature = 0.1 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature,
        cache_prompt: true,
        response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } },
      }),
    });
    if (!res.ok) throw new Error(`llm ${res.status}`);
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content?.trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming chat call: onToken fires per content delta as the model
 * produces it. Resolves with the full text (null = no service). The
 * abort signal cancels generation server-side (client disconnects flow
 * through here).
 */
export async function llmChatStream(opts: {
  system: string;
  user: string;
  maxTokens: number;
  onToken: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  temperature?: number;
}): Promise<string | null> {
  const baseUrl = llmBaseUrl();
  if (!baseUrl) return null;
  const { system, user, maxTokens, onToken, timeoutMs = 90_000, signal, fetchFn = fetch, temperature = 0.3 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onOuterAbort);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature,
        cache_prompt: true,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`llm ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // OpenAI-style SSE: lines of `data: {...}` ending with `data: [DONE]`.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const payload = line.startsWith('data: ') ? line.slice(6).trim() : null;
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) { full += delta; onToken(delta); }
        } catch { /* partial frame — ignored */ }
      }
    }
    return full.trim() || null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
