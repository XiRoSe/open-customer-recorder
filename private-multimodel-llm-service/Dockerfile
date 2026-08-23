# Summarizer sidecar: llama.cpp server + Qwen3.5-4B (Q4_K_M).
# Deployed as its own Railway service (root directory: summarizer/), no
# public domain — the app reaches it over private networking. Enable app
# sleeping: the worker wakes it in bursts, so idle hours cost nothing.
FROM ghcr.io/ggml-org/llama.cpp:server

# Model is baked into the image so cold starts don't re-download ~2.7 GB.
# To fine-tune later: replace this URL with your merged LoRA GGUF.
ADD https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf /models/model.gguf
# Vision adapter: lets the same model read replay screenshots (image_url
# parts in /v1/chat/completions).
ADD https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/mmproj-F16.gguf /models/mmproj.gguf

# THINK_BUDGET=0 / REASONING=off disable Qwen3.5's thinking mode — without
# them, all max_tokens go to reasoning_content and message.content is empty.
# (Two names because llama.cpp renamed the env var across versions.)
# PARALLEL=2 + CTX 8192: two lanes of 4096 each (llama.cpp SPLITS ctx
# across slots!) — one lane for background summaries, one reserved for
# the Researcher so a question never waits behind a vision job.
ENV LLAMA_ARG_HOST=0.0.0.0 \
    LLAMA_ARG_PORT=8080 \
    LLAMA_ARG_MODEL=/models/model.gguf \
    LLAMA_ARG_CTX_SIZE=8192 \
    LLAMA_ARG_N_PARALLEL=2 \
    LLAMA_ARG_THREADS=4 \
    LLAMA_ARG_THINK_BUDGET=0 \
    LLAMA_ARG_REASONING=off \
    LLAMA_ARG_MMPROJ=/models/mmproj.gguf

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD curl -sf http://localhost:8080/health || exit 1
