import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from '../local-history';
import { updateAiUsageConfig } from '../machine-config';

const [home, groupId, readyDirectory, barrierPath] = Bun.argv.slice(2);
if (!(home && groupId && readyDirectory && barrierPath)) {
  throw new Error('invalid subprocess arguments');
}

await writeFile(path.join(readyDirectory, `${process.pid}`), 'ready', 'utf8');
while (true) {
  try {
    await access(barrierPath);
    break;
  } catch {
    await Bun.sleep(5);
  }
}

const storage = createLocalHistoryStorage(home);
await Effect.runPromise(
  updateAiUsageConfig(async (config) => {
    await Bun.sleep(100);
    return {
      ...config,
      projectGroups: [
        ...(config.projectGroups ?? []),
        {
          id: groupId,
          name: groupId,
          sources: [{ machineId: 'fixture-machine', sourcePath: `/work/${groupId}` }],
        },
      ],
    };
  }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
);
