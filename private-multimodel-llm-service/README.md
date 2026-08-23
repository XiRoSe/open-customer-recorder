# private-multimodel-llm-service

llama.cpp serving Qwen3.5-4B (Q4_K_M) with an OpenAI-compatible API.
Turns session digests into 2-3 sentence intent summaries.

## Railway setup
1. New service in the same Railway project → deploy from this repo,
   **root directory `summarizer/`**.
2. No public domain. Note the private host, e.g. `summarizer.railway.internal`.
3. Enable **App Sleeping** on the service — the main app's worker wakes it
   in one burst per cycle; you pay only for active minutes.
4. Resources: ~4 GB RAM, 2+ vCPU. Expect 15-30 s per summary.
5. On the main app service set:
   - `LLM_SERVICE_URL=http://summarizer.railway.internal:8080`
   - `SUMMARIZER_MODEL_LABEL=qwen3.5-4b-q4km`

Unset `LLM_SERVICE_URL` to turn the LLM layer off — narratives and insight
badges keep working without it.

## Local smoke test

```bash
docker build -t summarizer summarizer/ && docker run -p 8080:8080 summarizer
curl -s localhost:8080/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hi"}],"max_tokens":10}'
```

## Fine-tuning (later)

Export training data: `node scripts/export-training-data.mjs > train.jsonl`.
Curate, LoRA-train (Unsloth supports Qwen3.5), merge to GGUF, replace the
ADD URL in the Dockerfile, redeploy. The app needs no changes.
