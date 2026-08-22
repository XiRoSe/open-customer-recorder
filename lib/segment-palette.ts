// Segment colors for cluster views — client-safe (no DB imports) so
// both the 'use client' map and server pages can share the assignment.
// Fixed categorical order per dimension (index = size rank); never cycle.
export const SEGMENT_PALETTE = [
  '#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#06b6d4', '#84cc16', '#d946ef',
];
