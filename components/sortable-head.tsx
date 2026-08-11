import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import type { SortDir } from '@/lib/table-sort';

export function SortableHead({ href, active, dir, children, className }: {
  href: string;
  active: boolean;
  dir: SortDir;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <TableHead className={className}>
      <Link href={href} className="inline-flex items-center gap-1 hover:text-foreground text-inherit transition-colors">
        {children}
        {active
          ? (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
          : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </Link>
    </TableHead>
  );
}
