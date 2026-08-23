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
