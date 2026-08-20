import { NextRequest, NextResponse } from 'next/server';
import { readSessionCookie } from '@/lib/auth';
import { getAppSettings, updateAppSettings, type AppSettings } from '@/lib/app-settings';

export async function GET() {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ settings: await getAppSettings(session.orgId) });
}

export async function PUT(req: NextRequest | Request) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: Partial<AppSettings>;
  try {
    body = await req.json() as Partial<AppSettings>;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const patch: Partial<AppSettings> = {};
  for (const key of ['summariesEnabled', 'intentEnabled', 'visualEnabled'] as const) {
    if (typeof body[key] === 'boolean') patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no valid flags in body' }, { status: 400 });
  }
  const settings = await updateAppSettings(session.orgId, patch);
  return NextResponse.json({ settings });
}
