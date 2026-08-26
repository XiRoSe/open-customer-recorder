/** Coarse device class from a user-agent string. Tablet is checked first:
 * Android tablets carry "Android" without "Mobile", iPads say iPad. */
export function deviceOf(userAgent: string | null | undefined): 'mobile' | 'tablet' | 'desktop' {
  if (!userAgent) return 'desktop';
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(userAgent)) return 'mobile';
  return 'desktop';
}
