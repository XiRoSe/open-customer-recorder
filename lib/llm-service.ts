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
