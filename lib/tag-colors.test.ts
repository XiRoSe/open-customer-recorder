import { describe, expect, it } from 'vitest';
import { TAG_COLORS, isValidTagColor } from './tag-colors';

describe('isValidTagColor', () => {
  it('accepts every color in the palette', () => {
    for (const c of TAG_COLORS) expect(isValidTagColor(c)).toBe(true);
  });

  it('rejects anything outside the palette', () => {
    expect(isValidTagColor('teal')).toBe(false);
    expect(isValidTagColor('')).toBe(false);
    expect(isValidTagColor('Green')).toBe(false); // case-sensitive
  });
});
