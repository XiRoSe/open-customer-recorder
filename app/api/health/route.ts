// Tiny no-op health endpoint for Railway's container healthcheck.
// Decoupled from / so a page-rendering issue can't ever block deploys.
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
}
