import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvironment } from './environment.js';

const fixtures: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ksapi-env-test-'));
  fixtures.push(root);
  mkdirSync(join(root, 'apps/api/src/lib'), { recursive: true });
  return root;
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('workspace environment loading', () => {
  it.each(['src/lib/environment.ts', 'dist/lib/environment.js'])('loads the repository .env for %s regardless of cwd', modulePath => {
    const root = fixture();
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://fixture/unused\nSESSION_SECRET=fixture-session\nKEY_ENCRYPTION_SECRET=fixture-key\n');
    writeFileSync(join(root, 'apps/api/.env'), 'DATABASE_URL=wrong-workspace-database\n');
    const environment: NodeJS.ProcessEnv = {};
    loadEnvironment({ moduleUrl: pathToFileURL(join(root, 'apps/api', modulePath)).href, environment });
    expect(environment).toMatchObject({ DATABASE_URL: 'postgres://fixture/unused', SESSION_SECRET: 'fixture-session', KEY_ENCRYPTION_SECRET: 'fixture-key' });
  });

  it('preserves explicitly injected production settings instead of overriding them with local values', () => {
    const root = fixture();
    writeFileSync(join(root, '.env'), 'NODE_ENV=development\nDATABASE_URL=postgres://local/unused\nSESSION_SECRET=local-secret\n');
    const environment = { NODE_ENV: 'production', DATABASE_URL: 'postgres://injected/unused', SESSION_SECRET: 'injected-secret' };
    loadEnvironment({ moduleUrl: pathToFileURL(join(root, 'apps/api/src/lib/environment.ts')).href, environment });
    expect(environment).toEqual({ NODE_ENV: 'production', DATABASE_URL: 'postgres://injected/unused', SESSION_SECRET: 'injected-secret' });
  });

  it('allows container startup without a dotenv file', () => {
    const root = fixture();
    const environment = { DATABASE_URL: 'postgres://injected/unused' };
    expect(() => loadEnvironment({ moduleUrl: pathToFileURL(join(root, 'apps/api/dist/lib/environment.js')).href, environment })).not.toThrow();
    expect(environment.DATABASE_URL).toBe('postgres://injected/unused');
  });

  it('does not load local credentials into a test environment', () => {
    const root = fixture();
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://live/unused\nTONCENTER_API_KEY=local-credential\n');
    const environment = { NODE_ENV: 'test' };
    loadEnvironment({ moduleUrl: pathToFileURL(join(root, 'apps/api/src/lib/environment.ts')).href, environment });
    expect(environment).toEqual({ NODE_ENV: 'test' });
  });

  it('uses an explicit dotenv file and reports a missing explicit file without leaking values', () => {
    const root = fixture();
    const explicitPath = join(root, '.env.host');
    writeFileSync(explicitPath, 'DATABASE_URL=postgres://host/unused\n');
    const environment: NodeJS.ProcessEnv = { DOTENV_CONFIG_PATH: explicitPath };
    loadEnvironment({ environment });
    expect(environment.DATABASE_URL).toBe('postgres://host/unused');
    rmSync(explicitPath);
    expect(() => loadEnvironment({ environment })).toThrow('Could not read the environment file');
  });
});
