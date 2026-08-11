'use client';
import { TAG_COLORS, TAG_COLOR_DOT_CLASS, type TagColor } from '@/lib/tag-colors';
import { cn } from '@/lib/utils';

export function ColorDots({ value, onChange, disabled }: { value: TagColor; onChange: (c: TagColor) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Tag color">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          disabled={disabled}
          onClick={() => onChange(c)}
          className={cn(
            'h-5 w-5 rounded-full ring-offset-2 ring-offset-background transition-all disabled:opacity-50',
            TAG_COLOR_DOT_CLASS[c],
            value === c ? 'ring-2 ring-foreground' : 'hover:ring-2 hover:ring-muted-foreground/50',
          )}
        />
      ))}
    </div>
  );
}
