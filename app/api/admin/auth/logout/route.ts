import { clearSessionCookie } from '@/lib/auth';

export async function POST() {
  await clearSessionCookie();
  // The header's Log out is a plain form post — 303 turns it into a GET.
  // The Location is RELATIVE on purpose: behind Railway's proxy req.url
  // is the container address (0.0.0.0:8080), so building an absolute URL
  // from it sends the browser to the wrong host. Browsers resolve a
  // relative Location against the real origin.
  return new Response(null, { status: 303, headers: { location: '/login' } });
}
