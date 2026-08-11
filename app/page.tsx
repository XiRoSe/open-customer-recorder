import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-semibold">Open Customer Recorder</h1>
      <p className="text-muted-foreground">Self-hosted session replay.</p>
      <Link href="/login" className={buttonVariants({ variant: 'default' })}>
        Log in
      </Link>
    </main>
  );
}
