import postgres, { type Sql } from 'postgres';
import { config } from '../config.js';

export const sql = postgres(config.DATABASE_URL, {
  max: config.NODE_ENV === 'test' ? 5 : 20,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: { options: `-c proxykey.allow_test_upstreams=${config.testUpstreamsEnabled ? 'on' : 'off'}` },
  transform: postgres.camel,
  onnotice: () => undefined,
});

export type Database = Sql;

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
}
