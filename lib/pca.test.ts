import { describe, it, expect } from 'vitest';
import { pca2d } from './pca';

describe('pca2d', () => {
  it('separates two blobs along the first axis', () => {
    const vectors: number[][] = [];
    for (let i = 0; i < 6; i++) {
      vectors.push([1 - i * 0.005, i * 0.005, 0.1]);   // blob A
      vectors.push([i * 0.005, 1 - i * 0.005, -0.1]);  // blob B
    }
    const coords = pca2d(vectors);
    expect(coords).toHaveLength(12);
    const a = coords.filter((_, i) => i % 2 === 0).map(([x]) => x);
    const b = coords.filter((_, i) => i % 2 === 1).map(([x]) => x);
    // Every A point is on the opposite side of every B point on PC1.
    expect(Math.min(...a) > Math.max(...b) || Math.max(...a) < Math.min(...b)).toBe(true);
  });

  it('bounds coordinates to [-1, 1] and handles empty input', () => {
    expect(pca2d([])).toEqual([]);
    const coords = pca2d([[3, 1], [-2, 5], [0, 0], [9, -4]]);
    for (const [x, y] of coords) {
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    const vs = [[1, 2, 3], [4, 5, 6], [7, 8, 10], [0, -1, 2]];
    expect(pca2d(vs)).toEqual(pca2d(vs));
  });
});
