'use client';
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    // Hard navigation: the (admin) layout reads the session server-side,
    // and a client-side push would keep rendering its logged-out shell
    // (no Log out button, no Researcher) until a manual reload.
    if (res.ok) window.location.assign('/projects');
    else setErr((await res.json()).error || 'login failed');
  }

  return (
    <main className="flex min-h-[calc(100vh-8rem)] items-center justify-center p-6">
      <Card className="w-full max-w-sm p-8 space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">Sign in to your dashboard.</p>
          <div aria-hidden className="flex items-center gap-1.5 pt-2">
            <div className="h-0.5 w-16 shrink-0 rounded-full bg-gradient-to-r from-[#B08D57] to-[#B08D57]/0" />
            <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" placeholder="you@company.com"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <Button type="submit" disabled={busy} className="w-full">{busy ? 'Logging in…' : 'Log in'}</Button>
        </form>
      </Card>
    </main>
  );
}
