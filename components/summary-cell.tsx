'use client';

import { useState } from 'react';

const PREVIEW_CHARS = 80;

/** Sessions-list summary preview: first ~80 chars + "view all" toggle.
 * The full text also rides the title attribute, so hovering shows it
 * without expanding. */
export function SummaryCell({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <span className="text-muted-foreground">—</span>;
  const needsTruncate = text.length > PREVIEW_CHARS;
  const preview = needsTruncate ? text.slice(0, PREVIEW_CHARS).trimEnd() + '…' : text;
  return (
    <div className="max-w-72 text-sm" title={text}>
      <span className="whitespace-pre-wrap">{expanded ? text : preview}</span>
      {needsTruncate && (
        <button
          type="button"
          className="ml-1 text-xs text-muted-foreground underline hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        >
          {expanded ? 'hide' : 'view all'}
        </button>
      )}
    </div>
  );
}
