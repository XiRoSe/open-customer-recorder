// Display metadata for insight kinds. Shared by the client summary card
// and server-rendered sessions list — keep this module free of 'use client'
// so server components can read it as a plain object.
export const INSIGHT_META: Record<string, { emoji: string; label: string }> = {
  rage_click: { emoji: '🔥', label: 'Rage click' },
  dead_click: { emoji: '💀', label: 'Dead click' },
  uturn: { emoji: '↩️', label: 'U-turn' },
  pogo_stick: { emoji: '🔁', label: 'Pogo-sticking' },
  refresh_loop: { emoji: '🔄', label: 'Refresh loop' },
  form_abandon: { emoji: '📝', label: 'Form abandoned' },
};
