import type { TimelinePatterns } from '@/lib/timeline';

const PATTERN_ROWS: [keyof TimelinePatterns, string, string][] = [
  ['peaks', 'Peak times', 'When sessions concentrate — the hours or days your traffic actually shows up.'],
  ['quiet', 'Quiet times', 'Stretches with little to no traffic, and what they imply.'],
  ['opportunity', 'Opportunity', 'The most actionable opening in this window’s numbers.'],
  ['watch', 'Worth watching', 'The metric or pattern most likely to change your read next.'],
];

/** The analyst-read card: takeaway prose plus the optional peak/quiet/
 * opportunity/watch grid. Shared by the Timeline page and the
 * Researcher's embedded analysis box — same component, same read. */
export function AnalystReadCard({ analysis, patterns }: { analysis: string; patterns?: TimelinePatterns | null }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md bg-muted/50 border-l-2 border-foreground/70 px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Analyst read</div>
        <p className="text-sm leading-relaxed m-0 max-w-4xl">{analysis}</p>
      </div>
      {patterns && (
        <div className="border-t pt-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3"
               title="An analyst read of this window's rhythm: when traffic peaks, when it goes quiet, the most actionable opening, and what to keep an eye on. Generated from the measured numbers above.">
            Patterns &amp; opportunities
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            {PATTERN_ROWS.filter(([key]) => patterns[key]).map(([key, label, explain]) => (
              <div key={key} className="border-l-2 border-foreground/20 pl-3">
                <div className="text-xs font-medium text-foreground mb-0.5 cursor-help" title={explain}>{label}</div>
                <p className="text-sm text-muted-foreground leading-relaxed m-0">{patterns[key]}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
