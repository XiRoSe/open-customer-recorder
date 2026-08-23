'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  lastLoginAt: string | null;
}

/** Team management (Settings). Everyone sees the list; only owners get
 * the add form and the row actions — the API enforces the same rule. */
export function TeamCard({ initialUsers, meId, canManage }: {
  initialUsers: TeamMember[];
  meId: string;
  canManage: boolean;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/team', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name, password }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `add failed (${res.status})`);
      setUsers((u) => [...u, { ...j.user, lastLoginAt: null }]);
      setEmail(''); setName(''); setPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add failed');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/team/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `update failed (${res.status})`);
      setUsers((u) => u.map((m) => (m.id === id ? { ...m, ...j.user } : m)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-0 divide-y">
      {users.map((u) => (
        <div key={u.id} className="flex items-center gap-3 p-3 text-sm">
          <div className="min-w-0 flex-1">
            <span className={`font-medium ${u.active ? '' : 'text-muted-foreground line-through'}`}>{u.name}</span>
            <span className="text-muted-foreground"> · {u.email}</span>
            {u.id === meId && <span className="text-muted-foreground"> (you)</span>}
          </div>
          <Badge variant={u.role === 'owner' ? 'default' : 'secondary'}>{u.role}</Badge>
          {!u.active && <Badge variant="outline">deactivated</Badge>}
          {canManage && (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => patch(u.id, { role: u.role === 'owner' ? 'member' : 'owner' })}
                className="text-xs text-muted-foreground hover:underline disabled:opacity-40 cursor-pointer"
              >
                {u.role === 'owner' ? 'Make member' : 'Make owner'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => patch(u.id, { active: !u.active })}
                className="text-xs text-muted-foreground hover:underline disabled:opacity-40 cursor-pointer"
              >
                {u.active ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          )}
        </div>
      ))}
      {canManage && (
        <div className="p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="block text-xs text-muted-foreground mb-1">Email</span>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="w-56 rounded-md border px-3 py-1.5 text-sm bg-background"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-muted-foreground mb-1">Name (optional)</span>
              <input
                type="text" value={name} onChange={(e) => setName(e.target.value)}
                className="w-36 rounded-md border px-3 py-1.5 text-sm bg-background"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-muted-foreground mb-1">Initial password</span>
              <input
                type="text" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="min 8 characters"
                className="w-44 rounded-md border px-3 py-1.5 text-sm bg-background"
              />
            </label>
            <button
              type="button"
              onClick={add}
              disabled={busy || !email || password.length < 8}
              className="rounded-md bg-foreground text-background px-4 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              Add member
            </button>
          </div>
          {error && <div className="text-sm text-rose-600 mt-2">{error}</div>}
        </div>
      )}
      {!canManage && error && <div className="p-3 text-sm text-rose-600">{error}</div>}
    </Card>
  );
}
