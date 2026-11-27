import { config as dotenv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** npm workspaces change cwd to apps/api; source and dist share the same repo root. */
export function loadEnvironment({
  moduleUrl = import.meta.url,
  environment = process.env,
}: { moduleUrl?: string; environment?: NodeJS.ProcessEnv } = {}): void {
  const explicitPath = environment.DOTENV_CONFIG_PATH;
  // Tests must not inherit developer credentials or payment settings from .env.
  if (environment.NODE_ENV === 'test' && !explicitPath) return;
  const path = explicitPath
    ? resolve(explicitPath)
    : fileURLToPath(new URL('../../../../.env', moduleUrl));
  const { error } = dotenv({ path, processEnv: environment, override: false, quiet: true });
  // Docker injects env directly and intentionally does not copy .env into its image.
  if (error && (explicitPath || (error as NodeJS.ErrnoException).code !== 'ENOENT')) {
    throw new Error('Could not read the environment file. Check DOTENV_CONFIG_PATH and file permissions.');
  }
}
