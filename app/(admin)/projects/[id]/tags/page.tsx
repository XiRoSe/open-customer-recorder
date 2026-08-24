import { redirect } from 'next/navigation';
import { db, schema } from '@/lib/db';
import { and, count, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { HeaderRule } from '@/components/header-rule';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell } from '@/components/ui/table';
import { AddTagRuleForm } from '@/components/add-tag-rule-form';
import { TagRuleRow } from '@/components/tag-rule-row';

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
      </div>

      <HeaderRule />

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
              <TagRuleRow key={r.id} projectId={id} rule={r} />
            ))}
          </TableBody>
        </Table>
      </Card>
    </main>
  );
}
