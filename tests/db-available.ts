import postgres from 'postgres';

let cached: boolean | null = null;

export async function isDbAvailable(): Promise<boolean> {
  if (cached !== null) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) return (cached = false);
  try {
    const client = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 2 });
    await client`select 1`;
    await client.end();
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}
