import { redirect } from 'next/navigation';
import { readSessionCookie } from '@/lib/auth';
import Link from 'next/link';
import { ProjectNav } from '@/components/project-nav';
import { Researcher } from '@/components/researcher/researcher';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await readSessionCookie();
  // Allow the /login page without session (it lives under (admin) but is public)
  // Strategy: just render children; protected pages check themselves via readSessionCookie + redirect.
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 bg-background border-b px-4 py-3">
        {/* flex-wrap: below sm, the nav (order-3, full width) drops to
            its own centered row instead of the absolute-centered
            desktop technique overlapping the brand/logout text — that
            technique ignores sibling widths entirely, which is exactly
            what caused the overlap on narrow screens. Desktop (sm+)
            keeps the identical absolute-centered look. */}
        <div className="relative flex items-center justify-between gap-x-3 gap-y-2 flex-wrap">
          <Link href="/projects" className="font-semibold tracking-wide shrink-0">PocketScience</Link>
          <div className="order-3 w-full flex justify-center overflow-x-auto sm:order-none sm:w-auto sm:overflow-visible sm:absolute sm:left-1/2 sm:-translate-x-1/2">
            <ProjectNav />
          </div>
          {session && (
            <form action="/api/admin/auth/logout" method="post" className="shrink-0">
              <button className="text-sm text-muted-foreground hover:underline cursor-pointer">Log out</button>
            </form>
          )}
        </div>
      </header>
      {/* The Researcher drawer sits in-flow beside the page content and
          squeezes it open/closed rather than covering it. */}
      <div className="flex-1 flex items-stretch">
        <div className="flex-1 min-w-0">{children}</div>
        {/* Renders only on project section pages (derives the project from the URL). */}
        {session && <Researcher name={session.name} email={session.email} />}
      </div>
    </div>
  );
}
