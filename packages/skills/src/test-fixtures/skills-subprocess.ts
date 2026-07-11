import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setSkillEnabled, writeSkillMarkdown } from '../index';

const waitForBarrier = async (readyDirectory: string, barrierPath: string, label: string): Promise<void> => {
  await writeFile(path.join(readyDirectory, label), 'ready', 'utf8');
  while (true) {
    try {
      await access(barrierPath);
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
};

const [operation, sourceRepoPath, value, readyDirectory, barrierPath, extra] = Bun.argv.slice(2);
if (!(operation && sourceRepoPath && value && readyDirectory && barrierPath)) {
  throw new Error('invalid subprocess arguments');
}

await waitForBarrier(readyDirectory, barrierPath, `${process.pid}`);
if (operation === 'toggle') {
  await setSkillEnabled(sourceRepoPath, value, false);
} else if (operation === 'markdown') {
  if (extra === undefined) {
    throw new Error('missing markdown base sha');
  }
  const result = await writeSkillMarkdown({
    baseSha256: extra,
    content: `# ${value}\n${value.repeat(20_000)}\n`,
    skillName: 'example-skill',
    sourceRepoPath,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  throw new Error(`unsupported subprocess operation: ${operation}`);
}
