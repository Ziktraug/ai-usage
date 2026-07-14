import { access, writeFile } from 'node:fs/promises';
import { writeSkillMarkdown } from '../skill-markdown-io';

const [sourceRepoPath, baseSha256, readyPath, barrierPath] = Bun.argv.slice(2);
if (!(sourceRepoPath && baseSha256 && readyPath && barrierPath)) {
  throw new Error('invalid crash writer arguments');
}

await writeFile(readyPath, 'ready', 'utf8');
while (true) {
  try {
    await access(barrierPath);
    break;
  } catch {
    await Bun.sleep(1);
  }
}
await writeSkillMarkdown({
  baseSha256,
  content: `# Interrupted edit\n${'x'.repeat(250_000)}\n`,
  skillName: 'example-skill',
  sourceRepoPath,
});
