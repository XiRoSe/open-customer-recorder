'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  ['overview', 'Overview'],
  ['sessions', 'Sessions'],
  ['timeline', 'Timeline'],
  ['users', 'Users'],
  ['clusters', 'Clusters'],
  ['tags', 'Tags'],
  ['settings', 'Settings'],
] as const;

/** Section tabs in the top bar. Derives the project and active section
 * from the URL, so the shared layout needs no page knowledge; renders
 * nothing outside a project's section pages. */
export function ProjectNav() {
  const pathname = usePathname();
  const m = pathname?.match(/^\/projects\/([^/]+)\/(overview|sessions|timeline|users|clusters|tags|settings)/);
  if (!m) return null;
  const [, id, active] = m;
  return (
    <nav className="flex gap-2 text-sm items-baseline flex-wrap justify-end">
      {TABS.map(([key, label], i) => (
        <span key={key} className="flex gap-2 items-baseline">
          {i > 0 && <span className="text-muted-foreground" aria-hidden>·</span>}
          {key === active ? (
            <span className="font-medium">{label}</span>
          ) : (
            <Link href={`/projects/${id}/${key}`} className="text-muted-foreground hover:underline">{label}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}
