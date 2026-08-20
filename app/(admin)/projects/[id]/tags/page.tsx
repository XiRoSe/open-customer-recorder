import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, count, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AddTagRuleForm } from '@/components/add-tag-rule-form';
import { ToggleTagRuleButton } from '@/components/toggle-tag-rule-button';
import { RecolorTagRule } from '@/components/recolor-tag-rule';
import type { TagColor } from '@/lib/tag-colors';

function describeRule(kind: string, value: string): string {
  if (kind === 'session_count_gte') return `Session count ≥ ${value}`;
  return `URL contains "${value}"`;
}

export default async function TagsPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) redirect('/projects');

  const rules = await db.select({
    id: schema.tagRules.id,
    name: schema.tagRules.name,
    kind: schema.tagRules.kind,
    value: schema.tagRules.value,
    color: schema.tagRules.color,
    enabled: schema.tagRules.enabled,
    taggedCount: count(schema.sessionTags.id),
  })
    .from(schema.tagRules)
    .leftJoin(schema.sessionTags, eq(schema.sessionTags.tagRuleId, schema.tagRules.id))
    .where(eq(schema.tagRules.projectId, id))
    .groupBy(schema.tagRules.id)
    .orderBy(schema.tagRules.createdAt);

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Tags</h1>
          <p className="text-sm text-muted-foreground">
            {rules.length} {rules.length === 1 ? 'rule' : 'rules'} — sessions are tagged automatically as they come in.
          </p>
        </div>
        <div className="flex gap-2 text-sm items-baseline">
          <Link href={`/projects/${id}/sessions`} className="text-muted-foreground hover:underline">Sessions</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/users`} className="text-muted-foreground hover:underline">Users</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/clusters`} className="text-muted-foreground hover:underline">Clusters</Link>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">Tags</span>
          <span className="text-muted-foreground">·</span>
          <Link href="/settings" className="text-muted-foreground hover:underline">Settings</Link>
        </div>
      </div>

      <AddTagRuleForm projectId={id} />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Color</TableHead>
              <TableHead>Tagged sessions</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No tag rules yet.</TableCell></TableRow>
            )}
            {rules.map((r) => (
              <TableRow key={r.id}>
                <TableCell><Badge variant={r.color as TagColor}>{r.name}</Badge></TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{describeRule(r.kind, r.value)}</TableCell>
                <TableCell>
                  <RecolorTagRule projectId={id} ruleId={r.id} color={r.color as TagColor} />
                </TableCell>
                <TableCell>{r.taggedCount}</TableCell>
                <TableCell>
                  <ToggleTagRuleButton projectId={id} ruleId={r.id} enabled={r.enabled} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </main>
  );
}
