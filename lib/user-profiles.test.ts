import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { sweepUserProfilesOnce, drainUserProfiles, profilesForVisitors, parseFacets } from './user-profiles';

describe('parseFacets', () => {
  it('parses the four labeled lines', () => {
    expect(parseFacets('Persona: A founder.\nIntent: Evaluate pricing.\nSource: Google search.\nExperience: Smooth, growing.')).toEqual({
      persona: 'A founder.', intent: 'Evaluate pricing.', source: 'Google search.', experience: 'Smooth, growing.',
    });
  });

  it('returns null for unstructured text', () => {
    expect(parseFacets('Just a plain old profile paragraph with no labels.')).toBeNull();
  });

  it('tolerates a partially structured reply (2+ facets)', () => {
    expect(parseFacets('Persona: A founder.\nIntent: Buy.')).toEqual({ persona: 'A founder.', intent: 'Buy.' });
  });
});

const dbReady = await isDbAvailable();
beforeEach(async () => {
  if (!dbReady) return;
  await resetDb();
  process.env.SUMMARIZER_URL = 'http://summarizer.test:8080';
});
afterEach(() => { delete process.env.SUMMARIZER_URL; });

async function seedVisitor(projectId: string, anonId: string, intents: string[]) {
  for (let i = 0; i < intents.length; i++) {
    const [s] = await db.insert(schema.sessions).values({
      projectId, anonId, startedAt: new Date(Date.now() - (intents.length - i) * 86_400_000),
      endedAt: new Date(), eventCount: 1, blobPath: '',
    }).returning();
    await db.insert(schema.sessionSummaries).values({
      sessionId: s.id, digest: {}, digestVersion: 1, narrative: '', insights: [],
      intentText: intents[i], status: 'done',
    });
  }
}

const okResponse = (text: string) => new Response(JSON.stringify({
  choices: [{ message: { content: text } }],
}), { status: 200 });

describe.skipIf(!dbReady)('user profiles', () => {
  it('sweep queues visitors with ≥2 summarized sessions, skips single-session visitors', async () => {
    const { project } = await createOrgWithProject();
    await seedVisitor(project.id, 'multi', ['Browsed pricing.', 'Signed up.']);
    await seedVisitor(project.id, 'single', ['Bounced.']);
    expect(await sweepUserProfilesOnce()).toBe(1);
    const rows = await db.select().from(schema.userProfiles);
    expect(rows).toHaveLength(1);
    expect(rows[0].visitorKey).toBe('multi');
    expect(rows[0].sessionsSummarized).toBe(2);
    expect(rows[0].status).toBe('pending');
  });

  it('drain feeds the newest summaries to the LLM and stores the profile', async () => {
    const { project } = await createOrgWithProject();
    await seedVisitor(project.id, 'multi', ['Browsed pricing.', 'Abandoned signup form.']);
    await sweepUserProfilesOnce();
    const fetchFn = vi.fn(async () => okResponse('A returning visitor evaluating the product.'));
    expect(await drainUserProfiles(fetchFn as unknown as typeof fetch)).toBe(1);
    const body = JSON.parse(String(((fetchFn.mock.calls[0] as unknown[])[1] as { body: string }).body));
    expect(body.messages[1].content).toContain('Visitor with 2 summarized sessions');
    expect(body.messages[1].content).toContain('Abandoned signup form.');
    expect(body.messages[1].content).toContain('Browsed pricing.');
    const m = await profilesForVisitors(project.id, ['multi']);
    expect(m.get('multi')).toMatchObject({ profileText: 'A returning visitor evaluating the product.', status: 'done' });
  });

  it('re-queues a done profile when the visitor gains another summarized session', async () => {
    const { project } = await createOrgWithProject();
    await seedVisitor(project.id, 'multi', ['One.', 'Two.']);
    await sweepUserProfilesOnce();
    const fetchFn = vi.fn(async () => okResponse('Profile v1.'));
    await drainUserProfiles(fetchFn as unknown as typeof fetch);
    // No change → sweep is a no-op.
    expect(await sweepUserProfilesOnce()).toBe(0);
    // A third summarized session arrives → counts diverge → re-queued.
    await seedVisitor(project.id, 'multi', ['Three.']);
    expect(await sweepUserProfilesOnce()).toBe(1);
    const [row] = await db.select().from(schema.userProfiles)
      .where(and(eq(schema.userProfiles.projectId, project.id), eq(schema.userProfiles.visitorKey, 'multi')));
    expect(row.status).toBe('pending');
    expect(row.sessionsSummarized).toBe(3);
    // Old profile text survives until the rebuild lands.
    expect(row.profileText).toBe('Profile v1.');
  });

  it('respects the profilesEnabled toggle', async () => {
    const { updateAppSettings } = await import('./app-settings');
    const { org, project } = await createOrgWithProject();
    await seedVisitor(project.id, 'multi', ['One.', 'Two.']);
    await updateAppSettings(org.id, { profilesEnabled: false });
    expect(await sweepUserProfilesOnce()).toBe(0);
    expect(await drainUserProfiles(vi.fn() as unknown as typeof fetch)).toBe(0);
  });
});
