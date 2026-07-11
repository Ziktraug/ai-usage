import { existsSync, symlinkSync, writeFileSync } from 'node:fs';

const [projectedPath, interloperPath, readyPath] = Bun.argv.slice(2);
if (!(projectedPath && interloperPath && readyPath)) {
  throw new Error('invalid interloper subprocess arguments');
}

writeFileSync(readyPath, 'ready', { encoding: 'utf8', mode: 0o600 });
while (existsSync(projectedPath)) {
  // A separate process is intentional: it deterministically exercises the filesystem race window.
}
symlinkSync(interloperPath, projectedPath);
