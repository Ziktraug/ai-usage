import { writeFile } from 'node:fs/promises';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from '../local-history';
import { ensureMachineConfig } from '../machine-config';

const [home, readyPath, barrierPath, resultPath] = process.argv.slice(2);
if (!(home && readyPath && barrierPath && resultPath)) {
  throw new Error('Expected home, ready, barrier, and result paths.');
}

await writeFile(readyPath, 'ready', 'utf8');
while (!(await Bun.file(barrierPath).exists())) {
  await Bun.sleep(5);
}
const machine = await Effect.runPromise(
  ensureMachineConfig.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
);
await writeFile(resultPath, `${JSON.stringify(machine)}\n`, 'utf8');
