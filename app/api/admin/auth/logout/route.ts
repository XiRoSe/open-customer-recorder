import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth';

export async function POST(req: NextRequest) {
  await clearSessionCookie();
  // The header's Log out is a plain form post — send the browser back to
  // the login page (303 turns the POST into a GET).
  return NextResponse.redirect(new URL('/login', req.url), 303);
}
