import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL not set, skipping');
  process.exit(0);
}

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

try {
  console.log('[migrate] applying migrations from ./lib/db/migrations');
  await migrate(db, { migrationsFolder: './lib/db/migrations' });
  console.log('[migrate] done');
} catch (err) {
  console.error('[migrate] failed:', err);
  process.exit(1);
} finally {
  await sql.end();
}
