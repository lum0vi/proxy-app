import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// This launcher runs on the host; the application uses Node 24 from Dockerfile.
const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2] ?? 'up';
if (!['up', 'stop', 'logs'].includes(action)) {
  console.error('Usage: node scripts/local-stack.mjs <up|stop|logs>');
  process.exit(1);
}
if (!existsSync(join(root, '.env'))) {
  console.error('Create the root .env from .env.example and fill the local settings before starting.');
  process.exit(1);
}
const choices = [{ command: 'docker', args: ['compose'] }, { command: 'docker-compose', args: [] }];
const compose = choices.find(({ command, args }) => spawnSync(command, [...args, 'version'], { cwd: root, stdio: 'ignore' }).status === 0);
if (!compose) {
  console.error('Docker Compose was not found. Install Docker CLI / Compose, then start Colima.');
  process.exit(1);
}
if (spawnSync('docker', ['info'], { cwd: root, stdio: 'ignore' }).status !== 0) {
  console.error('Docker is unavailable. Start Colima with: colima start --cpu 4 --memory 8 --disk 60');
  process.exit(1);
}
const base = [...compose.args, '--env-file', join(root, '.env'), '-f', join(root, 'docker-compose.yml'), '-f', join(root, 'docker-compose.local.yml')];
const commands = {
  up: ['up', '-d', '--build', '--wait', '--wait-timeout', '120'],
  stop: ['stop', '--timeout', '30'],
  logs: ['logs', '--tail', '100', 'migrate', 'api', 'worker', 'nginx'],
};
if (action === 'up') console.info('Starting Ksapi locally on loopback with docker-compose.local.yml.');
const child = spawn(compose.command, [...base, ...commands[action]], { cwd: root, stdio: 'inherit' });
child.on('error', () => { console.error('Could not start Docker Compose.'); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  process.exitCode = code ?? 1;
  if (code !== 0 || signal) {
    console.error('Local stack did not complete. Inspect the error with: npm run local:logs');
  } else if (action === 'up') {
    const port = spawnSync(compose.command, [...base, 'port', 'nginx', '80'], { cwd: root, encoding: 'utf8' });
    const match = /:(\d+)\s*$/.exec(port.stdout?.trim() ?? '');
    console.info(match ? `Ksapi is ready at http://localhost:${match[1]}` : 'Ksapi is ready. Check the published port with Docker Compose.');
  }
});
