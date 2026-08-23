import { redirect } from 'next/navigation';
import { readSessionCookie } from '@/lib/auth';
import Link from 'next/link';
import { ProjectNav } from '@/components/project-nav';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await readSessionCookie();
  // Allow the /login page without session (it lives under (admin) but is public)
  // Strategy: just render children; protected pages check themselves via readSessionCookie + redirect.
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b px-4 py-3 flex items-center justify-between">
        <Link href="/projects" className="font-semibold">Open Customer Recorder</Link>
        <div className="flex items-center gap-6">
          <ProjectNav />
          {session && (
            <form action="/api/admin/auth/logout" method="post">
              <button className="text-sm text-muted-foreground hover:underline">Log out</button>
            </form>
          )}
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
