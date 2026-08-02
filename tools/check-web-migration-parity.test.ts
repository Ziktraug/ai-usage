import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  baselineEvidenceCommit,
  type CurrentParityInventory,
  checkWebMigrationParity,
  type LoadedParityShard,
  loadParityShards,
  type PacketId,
  type ParityKind,
  type ParityRecord,
  type ParityShard,
  parsePlaywrightListOutput,
  validateParityShards,
} from './check-web-migration-parity';

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dir, '..');

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const validRecord = (overrides: Partial<ParityRecord> = {}): ParityRecord => ({
  currentOwner: 'apps/web/src/example.tsx',
  evidence: [{ commit: baselineEvidenceCommit, kind: 'test', reference: 'example.test.ts › preserves behavior' }],
  id: 'EXAMPLE-01',
  kind: 'feature',
  status: 'current',
  targetOwner: 'B1',
  ...overrides,
});

const loadedShard = (
  records: readonly ParityRecord[],
  owner: PacketId = 'B1',
  file = `${owner.toLowerCase()}.parity.ts`,
): LoadedParityShard => ({ file, shard: { owner, records } satisfies ParityShard });

const inventoryFor = (records: readonly ParityRecord[]): CurrentParityInventory => {
  const inventory = new Map<ParityKind, Map<string, { currentMethod?: 'GET' | 'POST'; currentOwner?: string }>>();
  for (const record of records) {
    const items = inventory.get(record.kind) ?? new Map();
    items.set(record.id, {
      ...(record.kind === 'operation' ? { currentMethod: record.operation?.currentMethod } : {}),
      currentOwner: record.currentOwner,
    });
    inventory.set(record.kind, items);
  }
  return inventory;
};

const validate = async (
  shards: readonly LoadedParityShard[],
  inventory: CurrentParityInventory,
  options: { integrated?: boolean; requireComplete?: boolean } = {},
) =>
  await validateParityShards(shards, inventory, {
    integratedEvidence: async () => options.integrated ?? true,
    requireComplete: options.requireComplete,
  });

describe('Web migration parity checker', () => {
  test('accepts owned current records and replacement evidence for retired source inventory', async () => {
    const current = validRecord();
    const replacement = validRecord({
      currentOwner: 'apps/web/src/retired.tsx',
      id: 'tsx:apps/web/src/retired.tsx',
      kind: 'production-tsx',
      status: 'complete',
    });
    const result = await validate([loadedShard([current, replacement])], inventoryFor([current]));

    expect(result.issues).toEqual([]);
    expect(result.counts.get('feature')).toEqual({ ledger: 1, live: 1, owned: 1 });
    expect(result.counts.get('production-tsx')).toEqual({ ledger: 1, live: 0, owned: 0 });
  });

  test('rejects duplicate, cross-shard, and unowned records', async () => {
    const first = validRecord();
    const duplicate = validRecord({ currentOwner: '', targetOwner: 'B1' });
    const result = await validate(
      [loadedShard([first]), loadedShard([duplicate], 'B2', 'foreign.parity.ts')],
      inventoryFor([first]),
    );

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('crosses shard ownership'),
        expect.stringContaining('has no currentOwner'),
        expect.stringContaining('not shard B2'),
        expect.stringContaining('duplicates EXAMPLE-01'),
      ]),
    );
  });

  test('rejects missing and stale current inventory records', async () => {
    const stale = validRecord({ id: 'STALE-01' });
    const required = validRecord({ id: 'REQUIRED-01' });
    const result = await validate([loadedShard([stale])], inventoryFor([required]));

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Missing feature ledger record for REQUIRED-01'),
        expect.stringContaining('Stale current feature record STALE-01'),
      ]),
    );
  });

  test('rejects evidence from a non-integrated commit', async () => {
    const record = validRecord();
    const result = await validate([loadedShard([record])], inventoryFor([record]), { integrated: false });

    expect(result.issues).toContain(
      `Evidence commit ${baselineEvidenceCommit} is not integrated into the checked HEAD.`,
    );
  });

  test('rejects unsupported removals and removals that still exist', async () => {
    const record = validRecord({ status: 'reviewed-removal' });
    const result = await validate([loadedShard([record])], inventoryFor([record]));

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unsupported removal without a reviewed replacementReason'),
        expect.stringContaining('is marked removed but still exists'),
      ]),
    );
  });

  test('requires every record to leave current status at the final gate', async () => {
    const record = validRecord();
    const result = await validate([loadedShard([record])], inventoryFor([record]), { requireComplete: true });

    expect(result.issues).toContain('b1.parity.ts record 0 remains current at the complete-only gate.');
  });

  test('checks operation methods, descriptors, and URL characterization', async () => {
    const operation = validRecord({
      id: 'op:example',
      kind: 'operation',
      operation: {
        currentMethod: 'GET',
        implementationOwner: '',
        inputParser: 'none',
        outputParser: 'schema',
        publicErrors: [],
        target: 'example.query',
        transport: 'query',
      },
    });
    const url = validRecord({ id: 'url:example', kind: 'url-contract' });
    const operationDescriptor = operation.operation;
    if (!operationDescriptor) {
      throw new Error('The operation fixture must include its descriptor.');
    }
    const inventory = inventoryFor([
      { ...operation, operation: { ...operationDescriptor, currentMethod: 'POST' } },
      url,
    ]);
    const result = await validate([loadedShard([operation, url])], inventory);

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('operation implementationOwner is empty'),
        expect.stringContaining('has no closed public error inventory'),
        expect.stringContaining('has no URL contract descriptor'),
        expect.stringContaining('current method is GET, expected POST'),
      ]),
    );
  });

  test('parses expanded Playwright list titles with stable file identities', () => {
    const inventory = parsePlaywrightListOutput(
      [
        'Listing tests:',
        '  accessibility.spec.ts:80:2 › Usage report exposes shared navigation without narrow overflow',
        '  session-scroll.scale.ts:566:2 › reaches every top-level production campaign exactly once on mobile',
        'Total: 2 tests in 2 files',
      ].join('\n'),
    );

    expect([...inventory.keys()]).toEqual([
      'pw:apps/web/e2e/accessibility.spec.ts::Usage report exposes shared navigation without narrow overflow',
      'pw:apps/web/e2e/session-scroll.scale.ts::reaches every top-level production campaign exactly once on mobile',
    ]);
  });

  test('discovers shard modules in deterministic lexical order without a barrel', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-parity-shards-'));
    temporaryDirectories.push(root);
    const directory = path.join(root, 'shards');
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, 'z.parity.ts'), "export default { owner: 'B1', records: [] };\n"),
      writeFile(path.join(directory, 'a.parity.ts'), "export const shard = { owner: 'B1', records: [] };\n"),
      writeFile(path.join(directory, 'ignored.ts'), "throw new Error('must not load');\n"),
    ]);

    expect((await loadParityShards(root, directory)).map(({ file }) => file)).toEqual(['a.parity.ts', 'z.parity.ts']);
  });

  test('accounts for the complete frozen repository inventory', async () => {
    const result = await checkWebMigrationParity(repositoryRoot);

    expect(result.issues).toEqual([]);
    expect(result.counts.get('feature')?.live).toBe(35);
    expect(result.counts.get('operation')?.live).toBe(30);
    expect(result.counts.get('production-tsx')?.live).toBe(72);
    expect(result.counts.get('design-export')?.live).toBe(385);
    expect(result.counts.get('playwright-title')?.live).toBe(104);
  });
});
