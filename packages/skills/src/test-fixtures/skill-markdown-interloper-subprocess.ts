import { existsSync, writeFileSync } from 'node:fs';

const [markdownPath, readyPath] = Bun.argv.slice(2);
if (!(markdownPath && readyPath)) {
  throw new Error('invalid markdown interloper subprocess arguments');
}

writeFileSync(readyPath, 'ready', { encoding: 'utf8', mode: 0o600 });
while (existsSync(markdownPath)) {
  // This process intentionally ignores the cooperative ai-usage lock.
}
writeFileSync(markdownPath, '# External edit\n', { encoding: 'utf8', flag: 'wx', mode: 0o640 });
