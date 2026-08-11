import { describe, expect, it, beforeEach } from 'vitest';
import { isExcluded, excludeUser, unexcludeUser, excludedAnonIdsAmong } from './excluded-users';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';

const dbReady = await isDbAvailable();

describe.skipIf(!dbReady)('excluded-users', () => {
  beforeEach(async () => { await resetDb(); });

  it('is not excluded by default', async () => {
    const { project } = await createOrgWithProject();
    expect(await isExcluded(project.id, 'a1')).toBe(false);
  });

  it('excludeUser then isExcluded is true, idempotent on repeat', async () => {
    const { project } = await createOrgWithProject();
    await excludeUser(project.id, 'a1');
    await excludeUser(project.id, 'a1');
    expect(await isExcluded(project.id, 'a1')).toBe(true);
  });

  it('unexcludeUser reverses it', async () => {
    const { project } = await createOrgWithProject();
    await excludeUser(project.id, 'a1');
    await unexcludeUser(project.id, 'a1');
    expect(await isExcluded(project.id, 'a1')).toBe(false);
  });

  it('exclusion is scoped per project', async () => {
    const { project: p1 } = await createOrgWithProject();
    const { project: p2 } = await createOrgWithProject();
    await excludeUser(p1.id, 'a1');
    expect(await isExcluded(p1.id, 'a1')).toBe(true);
    expect(await isExcluded(p2.id, 'a1')).toBe(false);
  });

  it('excludedAnonIdsAmong returns only the excluded subset', async () => {
    const { project } = await createOrgWithProject();
    await excludeUser(project.id, 'a1');
    const result = await excludedAnonIdsAmong(project.id, ['a1', 'a2', 'a3']);
    expect(result).toEqual(new Set(['a1']));
  });
});
