import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageSnapshot } from '@ai-usage/report-core/snapshot';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';

const LOOPBACK_HOST = '127.0.0.1';
const LOG_LIMIT_BYTES = 32 * 1024;
const START_DEADLINE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 1500;
const FIXTURE_PROJECT = 'setup-file-fixture';

const reserveFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a loopback TCP port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const nonLoopbackIpv4Address = (): string => {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4') {
        return address.address;
      }
    }
  }
  throw new Error('No non-loopback IPv4 address is available for the setup listener check.');
};

const captureLogs = (stream: ReadableStream<Uint8Array>) => {
  const retained: Uint8Array[] = [];
  let retainedBytes = 0;
  const done = (async () => {
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      if (retainedBytes < LOG_LIMIT_BYTES) {
        const remaining = LOG_LIMIT_BYTES - retainedBytes;
        const kept = chunk.value.slice(0, remaining);
        retained.push(kept);
        retainedBytes += kept.byteLength;
      }
    }
  })();
  return {
    done,
    text: () => new TextDecoder().decode(Buffer.concat(retained.map((chunk) => Buffer.from(chunk)))),
  };
};

const waitForSetup = async (port: number, child: Bun.Subprocess): Promise<void> => {
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Setup process exited before listening (code ${child.exitCode}).`);
    }
    try {
      const pageResponse = await fetch(`http://${LOOPBACK_HOST}:${port}/`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const page = await pageResponse.text();
      const sourcesResponse = await fetch(`http://${LOOPBACK_HOST}:${port}/api/sources`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const sources = (await sourcesResponse.json()) as unknown;
      const hasFixtureSource =
        Array.isArray(sources) &&
        sources.some(
          (source) =>
            typeof source === 'object' &&
            source !== null &&
            !Array.isArray(source) &&
            Reflect.get(source, 'project') === FIXTURE_PROJECT,
        );
      if (
        pageResponse.status === 200 &&
        page.includes('ai-usage project setup') &&
        page.includes(FIXTURE_PROJECT) &&
        hasFixtureSource
      ) {
        return;
      }
    } catch {
      // The bounded retry loop reports a single useful failure below.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Setup listener did not become ready on ${LOOPBACK_HOST}:${port}.`);
};

const requireNonLoopbackConnectionFailure = (host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = httpRequest({ host, method: 'GET', path: '/', port }, (response) => {
      response.resume();
      reject(new Error(`Setup listener unexpectedly accepted a connection through ${host}:${port}.`));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('non-loopback connection timed out'));
    });
    request.once('error', () => resolve());
    request.end();
  });

const stopChild = async (child: Bun.Subprocess): Promise<void> => {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(3000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await child.exited;
  }
};

const rootDir = path.resolve(import.meta.dir, '..');
const temporaryHome = await mkdtemp(path.join(tmpdir(), 'ai-usage-setup-smoke-'));
try {
  const snapshotPath = path.join(temporaryHome, 'setup-fixture.json');
  const fixtureDate = new Date('2026-07-13T10:00:00.000Z');
  const fixtureRow = normalizeUsageRow({
    calls: 1,
    cost: approximateApiCost,
    date: fixtureDate,
    endDate: fixtureDate,
    harness: 'Codex',
    model: 'gpt-5.3-codex',
    name: 'Setup file smoke',
    project: FIXTURE_PROJECT,
    provider: 'OpenAI',
    tokens: { cr: 0, cw: 0, in: 10, out: 5 },
  });
  await writeFile(
    snapshotPath,
    JSON.stringify(
      createUsageSnapshot({
        generatedAt: fixtureDate,
        machine: { id: 'setup-smoke-machine', label: 'Setup Smoke Machine' },
        rows: [
          {
            ...fixtureRow,
            source: {
              harnessKey: 'codex',
              sourcePath: `/work/${FIXTURE_PROJECT}`,
              sourceSessionId: 'setup-smoke-session',
            },
          },
        ],
      }),
    ),
    { mode: 0o600 },
  );
  const port = await reserveFreePort();
  const child = Bun.spawn(['bun', 'apps/cli/src/main.ts', 'setup', snapshotPath, '--port', String(port)], {
    cwd: rootDir,
    env: { ...process.env, HOME: temporaryHome },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = captureLogs(child.stdout);
  const stderr = captureLogs(child.stderr);

  try {
    await waitForSetup(port, child);
    await requireNonLoopbackConnectionFailure(nonLoopbackIpv4Address(), port);
    if (child.exitCode !== null) {
      throw new Error(`Setup process exited after listener checks (code ${child.exitCode}).`);
    }
    process.stdout.write('Setup listener is healthy and restricted to IPv4 loopback.\n');
  } catch (error) {
    const logs = `${stdout.text()}${stderr.text()}`.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\n${logs}` : ''}`);
  } finally {
    await stopChild(child);
    await Promise.all([stdout.done, stderr.done]);
  }
} finally {
  await rm(temporaryHome, { force: true, recursive: true });
}
