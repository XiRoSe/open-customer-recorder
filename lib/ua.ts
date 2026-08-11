import { UAParser } from 'ua-parser-js';

export function parseUA(uaString: string): { browser: string; os: string } {
  if (!uaString) return { browser: 'Unknown', os: 'Unknown' };
  const r = new UAParser(uaString).getResult();
  return {
    browser: r.browser.name || 'Unknown',
    os: r.os.name || 'Unknown',
  };
}
