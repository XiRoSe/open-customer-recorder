/**
 * Public lead-capture endpoint for the homepage reach-out form —
 * registration is invite-only, so this is the front door.
 *
 * The lead is ALWAYS stored in the leads table first; the email
 * notification is best-effort on top (Resend's plain HTTP API, no SDK),
 * so a mail-provider hiccup can never lose a lead. Configure with:
 *   CONTACT_EMAIL_TO    where notifications go
 *   RESEND_API_KEY      Resend API key (email is skipped without it)
 *   CONTACT_EMAIL_FROM  optional sender (defaults to Resend's onboarding sender)
 *
 * The `company` field is a honeypot: hidden from humans by CSS, so a
 * filled value means a bot — we answer 200 and store nothing.
 */
import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const honeypot = typeof body.company === 'string' ? body.company.trim() : '';
  if (honeypot) return NextResponse.json({ ok: true });

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : '';
  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'name, a valid email, and a message are required' }, { status: 400 });
  }

  const [lead] = await db.insert(schema.leads).values({ name, email, message }).returning();

  const to = process.env.CONTACT_EMAIL_TO;
  const key = process.env.RESEND_API_KEY;
  if (to && key) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: process.env.CONTACT_EMAIL_FROM || 'PocketScience <onboarding@resend.dev>',
          to: [to],
          reply_to: email,
          subject: `New lead: ${name}`,
          text: `Name: ${name}\nEmail: ${email}\n\n${message}\n\n— PocketScience reach-out form`,
        }),
      });
      if (res.ok) {
        await db.update(schema.leads).set({ notified: true }).where(eq(schema.leads.id, lead.id));
      } else {
        console.warn('[contact] notification email failed', res.status, await res.text().catch(() => ''));
      }
    } catch (e) {
      console.warn('[contact] notification email failed', e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({ ok: true });
}
