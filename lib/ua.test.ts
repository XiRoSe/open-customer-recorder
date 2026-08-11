import { describe, it, expect } from 'vitest';
import { parseUA } from './ua';

describe('parseUA', () => {
  it('parses Chrome on Windows', () => {
    const out = parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36');
    expect(out.browser).toBe('Chrome');
    expect(out.os).toBe('Windows');
  });
  it('returns Unknown for empty input', () => {
    const out = parseUA('');
    expect(out.browser).toBe('Unknown');
    expect(out.os).toBe('Unknown');
  });
});
