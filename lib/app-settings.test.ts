import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { getAppSettings, updateAppSettings, DEFAULT_SETTINGS } from './app-settings';

const dbReady = await isDbAvailable();
beforeEach(async () => { if (dbReady) await resetDb(); });

describe.skipIf(!dbReady)('app settings', () => {
  it('returns all-enabled defaults when no row exists', async () => {
    const { org } = await createOrgWithProject();
    expect(await getAppSettings(org.id)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when no org exists at all (org-agnostic call)', async () => {
    expect(await getAppSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('upserts a patch and keeps unpatched flags', async () => {
    const { org } = await createOrgWithProject();
    const after = await updateAppSettings(org.id, { visualEnabled: false });
    expect(after).toEqual({ summariesEnabled: true, intentEnabled: true, visualEnabled: false, profilesEnabled: true, clusteringEnabled: true });
    // Second patch on the existing row keeps the first change.
    const after2 = await updateAppSettings(org.id, { intentEnabled: false });
    expect(after2).toEqual({ summariesEnabled: true, intentEnabled: false, visualEnabled: false, profilesEnabled: true, clusteringEnabled: true });
    expect(await getAppSettings(org.id)).toEqual(after2);
  });

  it('org-agnostic read picks up the singleton org row', async () => {
    const { org } = await createOrgWithProject();
    await updateAppSettings(org.id, { summariesEnabled: false });
    expect((await getAppSettings()).summariesEnabled).toBe(false);
  });
});

