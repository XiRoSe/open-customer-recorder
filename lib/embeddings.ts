// Local text embeddings for clustering: all-MiniLM-L6-v2 (384-dim,
// ~23 MB quantized ONNX) via transformers.js, running in-process on CPU
// — milliseconds per text, no external service. The pipeline is a lazy
// singleton; the model downloads once per container into HF's cache.
let pipelinePromise: Promise<(texts: string[], opts: object) => Promise<{ tolist: () => number[][] }>> | null = null;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = import('@huggingface/transformers').then(async ({ pipeline }) => {
      const p = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
      return p as unknown as (texts: string[], opts: object) => Promise<{ tolist: () => number[][] }>;
    });
    pipelinePromise.catch(() => { pipelinePromise = null; });
  }
  return pipelinePromise;
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Mean-pooled, L2-normalized embeddings — unit vectors, so euclidean
 * k-means behaves like cosine k-means. */
export const embedTexts: EmbedFn = async (texts) => {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
};
