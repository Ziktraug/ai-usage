import { writeFile } from 'node:fs/promises';
import { writeSkillMarkdownWithHooks } from '../skill-markdown-io';

const [sourceRepoPath, baseSha256, readyPath] = Bun.argv.slice(2);
if (!(sourceRepoPath && baseSha256 && readyPath)) {
  throw new Error('invalid crash writer arguments');
}

await writeSkillMarkdownWithHooks(
  {
    baseSha256,
    content: `# Interrupted edit\n${'x'.repeat(250_000)}\n`,
    skillName: 'example-skill',
    sourceRepoPath,
  },
  {
    afterClaim: async () => {
      await writeFile(readyPath, 'ready', 'utf8');
      while (true) {
        await Bun.sleep(1000);
      }
    },
  },
);
