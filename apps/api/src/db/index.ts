import postgres, { type Sql } from 'postgres';
import { config } from '../config.js';

export const sql = postgres(config.DATABASE_URL, {
  max: config.NODE_ENV === 'test' ? 5 : 20,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: { options: [
    `-c proxykey.allow_test_upstreams=${config.testUpstreamsEnabled ? 'on' : 'off'}`,
    ...(config.UPSTREAM_KEY_SLOT_LIMIT === undefined ? [] : [`-c proxykey.upstream_key_slot_limit=${config.UPSTREAM_KEY_SLOT_LIMIT}`]),
  ].join(' ') },
  transform: postgres.camel,
  onnotice: () => undefined,
});

export type Database = Sql;

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
}
