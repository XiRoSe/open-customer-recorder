// Deterministic traffic-source categorization from referrer + entry URL.
// Order and colors are the chart's fixed categorical assignment —
// validated (CVD/contrast/chroma) with the dataviz palette checker;
// never reorder or cycle.
export const SOURCE_CATEGORIES = ['search', 'referral', 'ads', 'social', 'internal', 'direct'] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export const SOURCE_META: Record<SourceCategory, { label: string; color: string }> = {
  search: { label: 'Search', color: '#059669' },
  referral: { label: 'Referral', color: '#7c3aed' },
  ads: { label: 'Ads', color: '#d97706' },
  social: { label: 'Social', color: '#0284c7' },
  internal: { label: 'Internal', color: '#92400e' },
  direct: { label: 'Direct', color: '#db2777' },
};

const SEARCH_HOSTS = ['google.', 'bing.', 'duckduckgo.', 'yahoo.', 'yandex.', 'baidu.', 'ecosia.', 'search.brave.'];
const SOCIAL_HOSTS = ['linkedin.', 'facebook.', 'fb.', 'instagram.', 't.co', 'twitter.', 'x.com', 'reddit.', 'youtube.', 'tiktok.', 'pinterest.', 'threads.'];
const AD_PARAMS = ['gclid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'];
const AD_MEDIUMS = ['cpc', 'ppc', 'paid', 'paidsearch', 'paid_social', 'display', 'banner', 'ads'];

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** Categorize one session's acquisition. Ads beats everything (explicit
 * click ids / utm mediums), then search/social/internal by referrer
 * host, then referral for any other external referrer, else direct. */
export function categorizeSource(referrer: string | null | undefined, entryUrl: string | null | undefined): SourceCategory {
  try {
    if (entryUrl) {
      const u = new URL(entryUrl);
      for (const p of AD_PARAMS) if (u.searchParams.has(p)) return 'ads';
      const medium = (u.searchParams.get('utm_medium') ?? '').toLowerCase();
      if (AD_MEDIUMS.includes(medium)) return 'ads';
      const source = (u.searchParams.get('utm_source') ?? '').toLowerCase();
      if (source && AD_MEDIUMS.some((m) => medium.includes(m))) return 'ads';
    }
  } catch { /* bad entry url — fall through to referrer rules */ }

  const refHost = hostOf(referrer);
  if (!refHost) return 'direct';
  const entryHost = hostOf(entryUrl);
  if (refHost.includes('googleads') || refHost.includes('doubleclick')) return 'ads';
  if (SEARCH_HOSTS.some((h) => refHost.startsWith(h) || refHost.includes(`.${h}`))) return 'search';
  if (SOCIAL_HOSTS.some((h) => refHost.startsWith(h) || refHost.includes(`.${h}`))) return 'social';
  if (entryHost && refHost === entryHost) return 'internal';
  return 'referral';
}
