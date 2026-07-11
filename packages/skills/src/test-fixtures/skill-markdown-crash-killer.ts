import { existsSync, writeFileSync } from 'node:fs';

const [writerPidText, claimPath, readyPath, killedPath] = Bun.argv.slice(2);
const writerPid = Number(writerPidText);
if (!(Number.isSafeInteger(writerPid) && claimPath && readyPath && killedPath)) {
  throw new Error('invalid crash killer arguments');
}

writeFileSync(readyPath, 'ready', { encoding: 'utf8', mode: 0o600 });
while (!existsSync(claimPath)) {
  // Busy polling from another process makes the kill deterministic inside the claim window.
}
process.kill(writerPid, 'SIGKILL');
writeFileSync(killedPath, 'killed', { encoding: 'utf8', mode: 0o600 });
