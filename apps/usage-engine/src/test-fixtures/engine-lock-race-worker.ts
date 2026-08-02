import { writeFile } from 'node:fs/promises';
import { acquireUsageEngineLock } from '../engine-lock';

const [databasePath, stateDirectory, instanceId, readyPath, barrierPath, resultPath, releasePath] =
  process.argv.slice(2);

if (!(databasePath && stateDirectory && instanceId && readyPath && barrierPath && resultPath && releasePath)) {
  throw new Error('Usage engine lock race worker arguments are incomplete.');
}

await writeFile(readyPath, 'ready\n', { mode: 0o600 });
while (!(await Bun.file(barrierPath).exists())) {
  await Bun.sleep(2);
}

try {
  const lease = await acquireUsageEngineLock({ databasePath, instanceId, stateDirectory });
  await writeFile(resultPath, `${JSON.stringify({ pid: process.pid, state: 'acquired' })}\n`, {
    mode: 0o600,
  });
  while (!(await Bun.file(releasePath).exists())) {
    await Bun.sleep(2);
  }
  await lease.release();
} catch (error) {
  await writeFile(
    resultPath,
    `${JSON.stringify({
      message: error instanceof Error ? error.message : 'Unknown lock acquisition failure.',
      pid: process.pid,
      state: 'rejected',
    })}\n`,
    { mode: 0o600 },
  );
}
