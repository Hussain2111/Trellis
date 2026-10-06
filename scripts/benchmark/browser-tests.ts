import { spawn } from 'node:child_process';
import { buildProduction, createFixture, startServer, stopServer } from './fixture';

if (!process.argv.includes('--skip-build')) await buildProduction();
const fixture = await createFixture('small');
const server = await startServer(fixture.databaseUrl, 3101);
try {
  const child = spawn('npx', ['playwright', 'test'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      BENCHMARK_BASE_URL: server.baseURL,
      BENCHMARK_DATABASE_URL: fixture.databaseUrl,
    },
  });
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await stopServer(server.child);
}
