import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageSnapshot } from '@ai-usage/report-core/snapshot';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import type { ProjectSource } from '@ai-usage/report-data/portable-report';
import { Effect } from 'effect';
import {
  collectSetupSources,
  createSetupServer,
  MAX_SETUP_PROJECT_GROUPS,
  MAX_SETUP_PROJECT_SOURCES,
  SETUP_SERVER_HOSTNAME,
  setupHTML,
} from './setup';

const maliciousSource: ProjectSource = {
  gitRemote: '<img src=x onerror=alert(1)>',
  harness: 'Codex',
  harnesses: ['Codex'],
  harnessKey: 'codex',
  harnessKeys: ['codex'],
  id: 'source-1',
  machine: '<script>alert(1)</script>',
  machineId: 'machine-a',
  project: '<svg onload=alert(1)>',
  sessions: 1,
  sourcePath: '/tmp/<iframe src=javascript:alert(1)>',
  tokens: 10,
};

describe('setup HTML', () => {
  test('discovers project sources through the shared bounded snapshot reader', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'ai-usage-setup-snapshot-'));
    try {
      const snapshotPath = path.join(home, 'usage.json');
      const snapshot = createUsageSnapshot({
        generatedAt: new Date('2026-07-13T00:00:00.000Z'),
        machine: { id: 'fixture-machine', label: 'Fixture Machine' },
        rows: [
          {
            ...normalizeUsageRow({
              calls: 1,
              cost: approximateApiCost,
              date: new Date('2026-07-12T10:00:00.000Z'),
              endDate: new Date('2026-07-12T10:01:00.000Z'),
              harness: 'Codex',
              model: 'gpt-5.3-codex',
              name: 'Fixture session',
              project: 'fixture-project',
              provider: 'OpenAI',
              tokens: { cr: 0, cw: 0, in: 10, out: 5 },
            }),
            source: {
              harnessKey: 'codex',
              sourcePath: '/work/fixture-project',
              sourceSessionId: 'fixture-session',
            },
          },
        ],
      });
      await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');
      const result = await Effect.runPromise(collectSetupSources([snapshotPath]));

      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]).toMatchObject({
        machine: 'Fixture Machine',
        project: 'fixture-project',
        sourcePath: '/work/fixture-project',
      });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test('renders snapshot and config values through DOM text sinks', () => {
    const html = setupHTML(
      [maliciousSource],
      [
        {
          id: 'malicious-group',
          name: '<img src=x onerror=alert(1)>',
          sources: [{ project: '<script>alert(1)</script>' }],
        },
      ],
      [{ harness: '<svg onload=alert(1)>', message: '<iframe src=javascript:alert(1)>' }],
    );

    expect(html).not.toContain('.innerHTML');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('textContent = group.name');
    expect(html).toContain('textContent = s.gitRemote');
    expect(html).toContain("setAttribute('aria-label', 'Select ' + s.project)");
  });

  test('renders labeled keyboard controls and inline validation feedback', () => {
    const html = setupHTML([], [], []);

    expect(html).toContain('aria-label="Select all project sources"');
    expect(html).toContain('id="group-name-error" role="alert"');
    expect(html).toContain("deleteButton.setAttribute('aria-label', 'Remove project group ' + group.name)");
    expect(html).toContain("suggestionButton.type = 'button'");
    expect(html).not.toContain("alert('Enter a project group name')");
  });
});

const sendSetupRequest = (
  port: number,
  options: {
    bodyChunks?: string[];
    headers?: Record<string, string>;
    method?: string;
    path?: string;
  } = {},
): Promise<{ body: string; status: number }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: options.headers,
        hostname: SETUP_SERVER_HOSTNAME,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ body: Buffer.concat(chunks).toString('utf8'), status: response.statusCode ?? 0 });
        });
      },
    );
    request.once('error', reject);
    for (const chunk of options.bodyChunks ?? []) {
      request.write(chunk);
    }
    request.end();
  });

describe('setup HTTP boundary', () => {
  test('binds an actual closable listener to IPv4 loopback', async () => {
    const server = createSetupServer({
      port: 0,
      projectGroups: [],
      sources: [],
      warnings: [],
      writeProjectGroups: () => Promise.resolve(),
    });
    try {
      const response = await sendSetupRequest(server.port, { path: '/api/sources' });

      expect(server.hostname).toBe(SETUP_SERVER_HOSTNAME);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test('rejects hostile Host values on pages and source responses', async () => {
    const server = createSetupServer({
      port: 0,
      projectGroups: [],
      sources: [],
      warnings: [],
      writeProjectGroups: () => Promise.resolve(),
    });
    try {
      const page = await sendSetupRequest(server.port, { headers: { host: 'attacker.example' } });
      const sources = await sendSetupRequest(server.port, {
        headers: { host: 'attacker.example' },
        path: '/api/sources',
      });

      expect(page.status).toBe(403);
      expect(sources.status).toBe(403);
    } finally {
      await server.stop(true);
    }
  });

  test('requires same-origin JSON for project group writes', async () => {
    let writes = 0;
    const server = createSetupServer({
      port: 0,
      projectGroups: [],
      sources: [],
      warnings: [],
      writeProjectGroups: () => {
        writes += 1;
        return Promise.resolve();
      },
    });
    const localHost = `localhost:${server.port}`;
    try {
      const hostileOrigin = await sendSetupRequest(server.port, {
        bodyChunks: ['[]'],
        headers: {
          'content-type': 'application/json',
          host: localHost,
          origin: 'http://attacker.example',
        },
        method: 'PUT',
        path: '/api/project-groups',
      });
      const crossSite = await sendSetupRequest(server.port, {
        bodyChunks: ['[]'],
        headers: {
          'content-type': 'application/json',
          host: localHost,
          origin: `http://${localHost}`,
          'sec-fetch-site': 'cross-site',
        },
        method: 'PUT',
        path: '/api/project-groups',
      });
      const wrongContentType = await sendSetupRequest(server.port, {
        bodyChunks: ['[]'],
        headers: { 'content-type': 'text/plain', host: localHost, origin: `http://${localHost}` },
        method: 'PUT',
        path: '/api/project-groups',
      });
      const missingOrigin = await sendSetupRequest(server.port, {
        bodyChunks: ['[]'],
        headers: { 'content-type': 'application/json', host: localHost },
        method: 'PUT',
        path: '/api/project-groups',
      });
      const forwardedProtocol = await sendSetupRequest(server.port, {
        bodyChunks: ['[]'],
        headers: {
          'content-type': 'application/json',
          host: localHost,
          origin: `https://${localHost}`,
          'x-forwarded-proto': 'https',
        },
        method: 'PUT',
        path: '/api/project-groups',
      });

      expect(hostileOrigin.status).toBe(403);
      expect(crossSite.status).toBe(403);
      expect(wrongContentType.status).toBe(415);
      expect(missingOrigin.status).toBe(403);
      expect(forwardedProtocol.status).toBe(403);
      expect(writes).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test('bounds streamed project group bodies without invoking the engine client', async () => {
    let writes = 0;
    const server = createSetupServer({
      maxProjectGroupBodyBytes: 8,
      port: 0,
      projectGroups: [],
      sources: [],
      warnings: [],
      writeProjectGroups: () => {
        writes += 1;
        return Promise.resolve();
      },
    });
    const localHost = `localhost:${server.port}`;
    const requestHeaders = {
      'content-type': 'application/json',
      host: localHost,
      origin: `http://${localHost}`,
    };
    try {
      const oversized = await sendSetupRequest(server.port, {
        bodyChunks: ['[{"id":"x",', '"name":"x","sources":[]}'],
        headers: requestHeaders,
        method: 'PUT',
        path: '/api/project-groups',
      });

      expect(oversized.status).toBe(413);
      expect(writes).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test('enforces explicit group and source-selector limits without invoking the engine client', async () => {
    let writes = 0;
    const server = createSetupServer({
      port: 0,
      projectGroups: [],
      sources: [],
      warnings: [],
      writeProjectGroups: () => {
        writes += 1;
        return Promise.resolve();
      },
    });
    const localHost = `localhost:${server.port}`;
    const requestHeaders = {
      'content-type': 'application/json',
      host: localHost,
      origin: `http://${localHost}`,
    };
    try {
      const tooManyGroups = await sendSetupRequest(server.port, {
        bodyChunks: [
          JSON.stringify(
            Array.from({ length: MAX_SETUP_PROJECT_GROUPS + 1 }, (_, index) => ({
              id: `group-${index}`,
              name: 'x',
              sources: [{ project: `project-${index}` }],
            })),
          ),
        ],
        headers: requestHeaders,
        method: 'PUT',
        path: '/api/project-groups',
      });
      const tooManySources = await sendSetupRequest(server.port, {
        bodyChunks: [
          JSON.stringify([
            {
              id: 'group-a',
              name: 'x',
              sources: Array.from({ length: MAX_SETUP_PROJECT_SOURCES + 1 }, (_, index) => ({
                project: `project-${index}`,
              })),
            },
          ]),
        ],
        headers: requestHeaders,
        method: 'PUT',
        path: '/api/project-groups',
      });

      expect(tooManyGroups.status).toBe(413);
      expect(tooManySources.status).toBe(413);
      expect(writes).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test('validates the project group schema before invoking the engine client', async () => {
    let savedProjectGroups: unknown;
    const server = createSetupServer({
      port: 0,
      projectGroups: [],
      sources: [],
      warnings: [],
      writeProjectGroups: (projectGroups) => {
        savedProjectGroups = projectGroups;
        return Promise.resolve();
      },
    });
    const localHost = `localhost:${server.port}`;
    const headers = {
      'content-type': 'application/json',
      host: localHost,
      origin: `http://${localHost}`,
    };
    try {
      const invalid = await sendSetupRequest(server.port, {
        bodyChunks: ['[{"id":"example","name":"example","sources":[{"project":42}]}]'],
        headers,
        method: 'PUT',
        path: '/api/project-groups',
      });
      const validProjectGroups = [
        { id: 'example', name: 'example', sources: [{ machineId: 'machine-a', sourcePath: '/work/example' }] },
      ];
      const valid = await sendSetupRequest(server.port, {
        bodyChunks: [JSON.stringify(validProjectGroups)],
        headers,
        method: 'PUT',
        path: '/api/project-groups',
      });

      expect(invalid.status).toBe(422);
      expect(valid.status).toBe(200);
      expect(savedProjectGroups).toEqual(validProjectGroups);
    } finally {
      await server.stop(true);
    }
  });
});
