import { describe, it, expect } from 'vitest';
import { categorizeSource } from './traffic-source';

describe('categorizeSource', () => {
  it('ads beat everything: click ids and paid utm_medium', () => {
    expect(categorizeSource('https://www.google.com/', 'https://x.test/?gclid=abc')).toBe('ads');
    expect(categorizeSource(null, 'https://x.test/?fbclid=xyz')).toBe('ads');
    expect(categorizeSource('https://www.google.com/', 'https://x.test/lp?utm_medium=cpc&utm_source=google')).toBe('ads');
    expect(categorizeSource('https://googleads.g.doubleclick.net/', 'https://x.test/')).toBe('ads');
  });

  it('search engines', () => {
    expect(categorizeSource('https://www.google.com/', 'https://x.test/')).toBe('search');
    expect(categorizeSource('https://www.bing.com/search?q=x', 'https://x.test/')).toBe('search');
    expect(categorizeSource('https://duckduckgo.com/', 'https://x.test/')).toBe('search');
  });

  it('social networks', () => {
    expect(categorizeSource('https://www.linkedin.com/feed/', 'https://x.test/')).toBe('social');
    expect(categorizeSource('https://t.co/abc', 'https://x.test/')).toBe('social');
    expect(categorizeSource('https://www.reddit.com/r/saas/', 'https://x.test/')).toBe('social');
  });

  it('internal when referrer host equals entry host (www-insensitive)', () => {
    expect(categorizeSource('https://www.x.test/blog', 'https://x.test/pricing')).toBe('internal');
  });

  it('referral for any other external referrer', () => {
    expect(categorizeSource('https://news.ycombinator.com/', 'https://x.test/')).toBe('referral');
  });

  it('direct when no referrer, robust to junk', () => {
    expect(categorizeSource(null, 'https://x.test/')).toBe('direct');
    expect(categorizeSource('', null)).toBe('direct');
    expect(categorizeSource('not a url', 'also not a url')).toBe('direct');
  });
});
