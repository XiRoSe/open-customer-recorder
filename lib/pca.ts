// Top-2 PCA projection for the cluster map: 384-dim MiniLM embeddings
// → 2D coordinates in [-1, 1]. Power iteration with deflation — pure,
// deterministic (fixed seed), no dependencies, and fast at our scale
// (hundreds of profiles × 384 dims = milliseconds).

function project(X: number[][], v: number[]): number[] {
  return X.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}

export function pca2d(vectors: number[][]): [number, number][] {
  const n = vectors.length;
  if (n === 0) return [];
  const d = vectors[0].length;
  const mean = new Array(d).fill(0);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const X = vectors.map((v) => v.map((x, j) => x - mean[j]));

  // v ← Xᵀ(Xv), normalized — leading eigenvector of the covariance.
  const matVec = (v: number[]): number[] => {
    const Xv = project(X, v);
    const out = new Array(d).fill(0);
    X.forEach((row, i) => { for (let j = 0; j < d; j++) out[j] += row[j] * Xv[i]; });
    return out;
  };
  const orthogonalize = (v: number[], against: number[]): number[] => {
    const dot = v.reduce((s, x, j) => s + x * against[j], 0);
    return v.map((x, j) => x - dot * against[j]);
  };
  const powerIter = (deflate?: number[]): number[] => {
    let v = Array.from({ length: d }, (_, i) => Math.sin(i + 1)); // fixed seed
    for (let it = 0; it < 60; it++) {
      if (deflate) v = orthogonalize(v, deflate);
      let w = matVec(v);
      if (deflate) w = orthogonalize(w, deflate);
      const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
      if (norm === 0) return v;
      v = w.map((x) => x / norm);
    }
    return v;
  };

  const p1 = powerIter();
  const p2 = powerIter(p1);
  const coords = X.map((row) => [
    row.reduce((s, x, j) => s + x * p1[j], 0),
    row.reduce((s, x, j) => s + x * p2[j], 0),
  ] as [number, number]);
  const maxAbs = Math.max(1e-9, ...coords.flat().map(Math.abs));
  return coords.map(([x, y]) => [x / maxAbs, y / maxAbs]);
}
