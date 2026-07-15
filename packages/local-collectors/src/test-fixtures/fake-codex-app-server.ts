import { writeFileSync } from 'node:fs';

const logPath = process.argv[2];
const mode = process.argv[3] ?? 'success';
if (!logPath) {
  throw new Error('A request log path is required');
}

const requests: { id?: number; method: string }[] = [];
let buffer = '';
const persist = () => writeFileSync(logPath, JSON.stringify(requests));
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let lineEnd = buffer.indexOf('\n');
  while (lineEnd >= 0) {
    const line = buffer.slice(0, lineEnd);
    buffer = buffer.slice(lineEnd + 1);
    const request = JSON.parse(line) as { id?: number; method: string };
    requests.push({ ...(request.id === undefined ? {} : { id: request.id }), method: request.method });
    persist();
    if (request.method === 'initialize') {
      send({ id: request.id, result: { serverInfo: { name: 'fixture', version: '1' } } });
    }
    if (request.method === 'account/rateLimits/read') {
      send({ method: 'account/rateLimits/updated', params: {} });
      if (mode === 'auth-error') {
        send({ error: { code: -32_001, message: 'not logged in: secret fixture detail' }, id: request.id });
      } else {
        send({
          id: request.id,
          result: {
            rateLimitResetCredits: null,
            rateLimits: {
              credits: null,
              individualLimit: null,
              limitId: 'codex',
              limitName: 'Codex',
              planType: 'plus',
              primary: { resetsAt: 1_752_576_000, usedPercent: 25, windowDurationMins: 300 },
              rateLimitReachedType: null,
              secondary: { resetsAt: 1_753_056_000, usedPercent: 70, windowDurationMins: 10_080 },
            },
            rateLimitsByLimitId: null,
          },
        });
      }
    }
    lineEnd = buffer.indexOf('\n');
  }
});
