import { redirect } from 'next/navigation';
import { readSessionCookie } from '@/lib/auth';

/** Self-hosted build has no marketing page: land on the dashboard,
 * or the login screen when signed out. */
export default async function Home() {
  const session = await readSessionCookie();
  redirect(session ? '/projects' : '/login');
}
