/**
 * Country lookup from request IP.
 *
 * Railway / our standard ingress don't set cf-ipcountry or
 * x-vercel-ip-country, so we fall back to a free public service.
 *
 * ip-api.com: free for ~45 req/min from a single IP, no key.
 * We cap each lookup at 600ms so a slow lookup never blocks ingest.
 */

function ipFromHeaders(headers: Headers): string | null {
  // Already-known country headers (CF, Vercel) — skip lookup
  const direct = headers.get('cf-ipcountry') || headers.get('x-vercel-ip-country');
  if (direct && direct.length === 2) return null; // signal "skip lookup"
  // Standard forwarded-for; first entry is client IP
  const fwd = headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip') || null;
}

const cache = new Map<string, { country: string | null; expires: number }>();
const TTL_MS = 60 * 60 * 1000;

export async function countryFromHeaders(headers: Headers): Promise<string | null> {
  const direct = headers.get('cf-ipcountry') || headers.get('x-vercel-ip-country');
  if (direct && direct.length === 2) return direct;

  const ip = ipFromHeaders(headers);
  if (!ip) return null;

  const cached = cache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.country;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 600);
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,status`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      cache.set(ip, { country: null, expires: Date.now() + TTL_MS });
      return null;
    }
    const j = (await res.json()) as { status?: string; countryCode?: string };
    const country = j.status === 'success' && j.countryCode ? j.countryCode : null;
    cache.set(ip, { country, expires: Date.now() + TTL_MS });
    return country;
  } catch {
    cache.set(ip, { country: null, expires: Date.now() + TTL_MS });
    return null;
  }
}
