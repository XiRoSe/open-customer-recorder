# Summarizer sidecar: llama.cpp server + Qwen3.5-4B (Q4_K_M).
# Deployed as its own Railway service (root directory: summarizer/), no
# public domain — the app reaches it over private networking. Enable app
# sleeping: the worker wakes it in bursts, so idle hours cost nothing.
FROM ghcr.io/ggml-org/llama.cpp:server

# Model is baked into the image so cold starts don't re-download ~2.7 GB.
# To fine-tune later: replace this URL with your merged LoRA GGUF.
ADD https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf /models/model.gguf

# THINK_BUDGET=0 / REASONING=off disable Qwen3.5's thinking mode — without
# them, all max_tokens go to reasoning_content and message.content is empty.
# (Two names because llama.cpp renamed the env var across versions.)
ENV LLAMA_ARG_HOST=0.0.0.0 \
    LLAMA_ARG_PORT=8080 \
    LLAMA_ARG_MODEL=/models/model.gguf \
    LLAMA_ARG_CTX_SIZE=4096 \
    LLAMA_ARG_THREADS=4 \
    LLAMA_ARG_THINK_BUDGET=0 \
    LLAMA_ARG_REASONING=off

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD curl -sf http://localhost:8080/health || exit 1
