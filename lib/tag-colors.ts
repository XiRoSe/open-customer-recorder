/**
 * The tag color palette — client-safe (no DB imports), so both server
 * code (lib/tag-rules.ts) and client components (color pickers) can use
 * it without pulling server-only code into the browser bundle.
 */
export const TAG_COLORS = ['green', 'blue', 'purple', 'amber', 'red', 'gray'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export function isValidTagColor(v: string): v is TagColor {
  return (TAG_COLORS as readonly string[]).includes(v);
}

/** Solid dot swatch classes for color pickers — distinct from the
 * translucent Badge variant styling, which needs to stay legible as
 * background text. */
export const TAG_COLOR_DOT_CLASS: Record<TagColor, string> = {
  green: 'bg-green-500',
  blue: 'bg-blue-500',
  purple: 'bg-purple-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  gray: 'bg-gray-500',
};
