/**
 * Tag rule kind metadata + pure matching predicates — no db import, safe
 * for client components (the add/edit rule forms) to pull in directly.
 * The db-touching half (tagSession, applyRuleToExistingSessions) lives in
 * lib/tag-rules.ts, which re-exports everything here for server callers.
 *
 * Kinds fall into three evaluation lifecycles, because each needs
 * different inputs:
 *
 * - 'url_contains': value is a case-insensitive substring checked against
 *   every URL a session visited (Meta + mega-url-change hrefs, via
 *   lib/url-timeline.ts hrefOf). Evaluated incrementally at ingest time.
 * - 'session_count_gte': value is a stringified threshold checked against
 *   how many sessions the same anon_id has had (1-indexed, this session
 *   included). Evaluated once, at session creation.
 * - 'browser_is' / 'country_is' / 'device_is' / 'referrer_contains' /
 *   'source_is': single facts known the instant the session row is
 *   created (UA, geoip, referrer, entry URL) — never change mid-session,
 *   so evaluated once, at session creation (matchingCreationRules).
 * - 'duration_gte': value is a stringified second threshold; duration
 *   only grows, so it's re-checked on every ingest batch
 *   (matchingDurationRules) until it first crosses the bar, then stays
 *   tagged (sticky, same philosophy as everything else here).
 *
 * See docs/superpowers/specs/2026-08-11-tag-rules-system-design.md.
 */
import { SOURCE_CATEGORIES } from '@/lib/traffic-source';

export { TAG_COLORS, isValidTagColor, type TagColor } from '@/lib/tag-colors';

export interface TagRule {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  value: string;
  color: string;
  enabled: boolean;
}

export const RULE_KINDS = [
  'url_contains',
  'session_count_gte',
  'browser_is',
  'country_is',
  'device_is',
  'referrer_contains',
  'source_is',
  'duration_gte',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** UI + display metadata for each rule kind, kept in one place so the
 * add form, edit form, and rule-list description all stay in sync. */
export const RULE_KIND_META: Record<RuleKind, {
  label: string;
  valueLabel: string;
  valueType: 'text' | 'number' | 'select';
  options?: readonly string[];
  placeholder?: string;
  describe: (value: string) => string;
}> = {
  url_contains: { label: 'URL contains', valueLabel: 'Substring', valueType: 'text', placeholder: 'register', describe: (v) => `URL contains "${v}"` },
  session_count_gte: { label: 'Session count ≥', valueLabel: 'Threshold', valueType: 'number', placeholder: '2', describe: (v) => `Session count ≥ ${v}` },
  browser_is: { label: 'Browser is', valueLabel: 'Browser', valueType: 'text', placeholder: 'Chrome', describe: (v) => `Browser is "${v}"` },
  country_is: { label: 'Country is', valueLabel: 'Country code', valueType: 'text', placeholder: 'US', describe: (v) => `Country is ${v.toUpperCase()}` },
  device_is: { label: 'Device is', valueLabel: 'Device', valueType: 'select', options: ['mobile', 'tablet', 'desktop'], describe: (v) => `Device is ${v}` },
  referrer_contains: { label: 'Referrer contains', valueLabel: 'Substring', valueType: 'text', placeholder: 'linkedin.com', describe: (v) => `Referrer contains "${v}"` },
  source_is: { label: 'Traffic source is', valueLabel: 'Source', valueType: 'select', options: SOURCE_CATEGORIES, describe: (v) => `Traffic source is ${v}` },
  duration_gte: { label: 'Duration ≥ (seconds)', valueLabel: 'Seconds', valueType: 'number', placeholder: '60', describe: (v) => `Duration ≥ ${v}s` },
};

export function isValidRuleKind(kind: string): kind is RuleKind {
  return (RULE_KINDS as readonly string[]).includes(kind);
}

export function describeRule(kind: string, value: string): string {
  const meta = isValidRuleKind(kind) ? RULE_KIND_META[kind] : null;
  return meta ? meta.describe(value) : `${kind} "${value}"`;
}

/** Case-insensitive substring match against a URL. */
export function matchesUrlContains(ruleValue: string, href: string): boolean {
  return href.toLowerCase().includes(ruleValue.toLowerCase());
}

/** Does `sessionNumber` (1-indexed among the same anon_id's sessions) meet
 * a session_count_gte rule's threshold? */
export function matchesSessionCount(ruleValue: string, sessionNumber: number): boolean {
  const threshold = parseInt(ruleValue, 10);
  return Number.isFinite(threshold) && sessionNumber >= threshold;
}

export function matchesBrowserIs(ruleValue: string, browser: string | null | undefined): boolean {
  return !!browser && browser.toLowerCase() === ruleValue.toLowerCase();
}

export function matchesCountryIs(ruleValue: string, country: string | null | undefined): boolean {
  return !!country && country.toLowerCase() === ruleValue.toLowerCase();
}

export function matchesDeviceIs(ruleValue: string, device: string): boolean {
  return device.toLowerCase() === ruleValue.toLowerCase();
}

export function matchesReferrerContains(ruleValue: string, referrer: string | null | undefined): boolean {
  return !!referrer && referrer.toLowerCase().includes(ruleValue.toLowerCase());
}

export function matchesSourceIs(ruleValue: string, source: string): boolean {
  return source.toLowerCase() === ruleValue.toLowerCase();
}

/** Does a session's duration (in seconds) meet a duration_gte rule's
 * threshold? Re-checked on every ingest batch since duration only grows —
 * once true it stays tagged (sticky), matching this file's philosophy. */
export function matchesDurationGte(ruleValue: string, durationSeconds: number): boolean {
  const threshold = parseInt(ruleValue, 10);
  return Number.isFinite(threshold) && durationSeconds >= threshold;
}

/** Facts known the instant a session row is created — never change
 * mid-session, so the five single-fact kinds evaluate against these once. */
export interface CreationContext {
  browser: string | null;
  country: string | null;
  device: string;
  referrer: string | null;
  source: string;
}

/** Which enabled single-fact rules (browser/country/device/referrer/source)
 * match a just-created session. Called once, right after insert. */
export function matchingCreationRules(rules: TagRule[], ctx: CreationContext): TagRule[] {
  return rules.filter((r) => {
    if (!r.enabled) return false;
    switch (r.kind) {
      case 'browser_is': return matchesBrowserIs(r.value, ctx.browser);
      case 'country_is': return matchesCountryIs(r.value, ctx.country);
      case 'device_is': return matchesDeviceIs(r.value, ctx.device);
      case 'referrer_contains': return matchesReferrerContains(r.value, ctx.referrer);
      case 'source_is': return matchesSourceIs(r.value, ctx.source);
      default: return false;
    }
  });
}

/** Which enabled duration_gte rules a session's duration-so-far (seconds)
 * newly satisfies — re-checked every ingest batch. */
export function matchingDurationRules(rules: TagRule[], durationSeconds: number): TagRule[] {
  return rules.filter((r) => r.enabled && r.kind === 'duration_gte' && matchesDurationGte(r.value, durationSeconds));
}

/**
 * Which enabled url_contains rules does this ingest batch match — checked
 * against the page-url param and every event's href in one pass.
 */
export function matchingUrlContainsRules(
  rules: TagRule[],
  pageUrl: string | null,
  hrefs: (string | null)[],
): TagRule[] {
  const candidates = rules.filter((r) => r.enabled && r.kind === 'url_contains');
  if (candidates.length === 0) return [];
  const urls = [pageUrl, ...hrefs].filter((h): h is string => !!h);
  if (urls.length === 0) return [];
  return candidates.filter((r) => urls.some((u) => matchesUrlContains(r.value, u)));
}
