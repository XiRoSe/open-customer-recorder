import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

export interface AppSettings {
  summariesEnabled: boolean;
  intentEnabled: boolean;
  visualEnabled: boolean;
  profilesEnabled: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  summariesEnabled: true,
  intentEnabled: true,
  visualEnabled: true,
  profilesEnabled: true,
};

/** Settings for the given org, or for the singleton org when omitted
 * (background workers are org-agnostic in this single-org product).
 * Missing row = defaults, everything enabled. */
export async function getAppSettings(orgId?: string): Promise<AppSettings> {
  let id = orgId;
  if (!id) {
    const [org] = await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
    if (!org) return { ...DEFAULT_SETTINGS };
    id = org.id;
  }
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.orgId, id)).limit(1);
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    summariesEnabled: row.summariesEnabled,
    intentEnabled: row.intentEnabled,
    visualEnabled: row.visualEnabled,
    profilesEnabled: row.profilesEnabled,
  };
}

export async function updateAppSettings(orgId: string, patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getAppSettings(orgId);
  const next = { ...current, ...patch };
  await db.insert(schema.appSettings)
    .values({ orgId, ...next })
    .onConflictDoUpdate({
      target: schema.appSettings.orgId,
      set: { ...next, updatedAt: new Date() },
    });
  return next;
}

