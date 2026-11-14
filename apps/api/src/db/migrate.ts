import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql, closeDatabase } from './index.js';

async function migrate(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(currentDir, '../../migrations');
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();

  for (const filename of files) {
    const existing = await sql<{ filename: string }[]>`
      SELECT filename FROM schema_migrations WHERE filename = ${filename}
    `;
    if (existing.length > 0) continue;

    const migration = await readFile(join(migrationsDir, filename), 'utf8');
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction`INSERT INTO schema_migrations (filename) VALUES (${filename})`;
    });
    console.info(`Applied migration ${filename}`);
  }
}

migrate()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
