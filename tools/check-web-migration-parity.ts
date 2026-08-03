import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { asParityShard, type LoadedParityShard, loadParityShards } from '@ai-usage/web/migration-parity/aggregate';
import {
  baselineEvidenceCommit,
  designRowIds,
  featureIds,
  isEvidenceKind,
  isEvidencePhase,
  isPacketId,
  isParityKind,
  isParityStatus,
  type ParityEvidence,
  type ParityKind,
  type ParityRecord,
  parityKinds,
  renderSuitePaths,
  urlContractIds,
} from '@ai-usage/web/migration-parity/schema';
import ts from 'typescript';

const commitPattern = /^[a-f0-9]{40}$/u;
const serverOperationPattern =
  /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*createServerFn\(\s*\{\s*method:\s*['"](GET|POST)['"]\s*\}\s*\)/gu;
const playwrightListPattern = /^\s+(.+?):\d+:\d+\s+›\s+(.+)$/u;
const sourceEntrypointPattern = /^\.\/src\/.*\.tsx?$/u;
const ignoredInventoryDirectories = new Set([
  '.git',
  '.output',
  '.output-build',
  '.output-dev',
  '.output-svelte-shadow',
  '.svelte-kit',
  '.svelte-kit-shadow',
  '.turbo',
  'dist',
  'node_modules',
  'styled-system',
]);

interface InventoryItem {
  currentMethod?: 'GET' | 'POST';
  currentOwner?: string;
}

export type CurrentParityInventory = ReadonlyMap<ParityKind, ReadonlyMap<string, InventoryItem>>;

export interface ParityKindCount {
  ledger: number;
  live: number;
  owned: number;
}

export interface ParityCheckResult {
  counts: ReadonlyMap<ParityKind, ParityKindCount>;
  issues: readonly string[];
}

export interface ValidateParityOptions {
  integratedEvidence: (commit: string) => Promise<boolean>;
  requireComplete?: boolean;
}

interface PlaywrightCollection {
  config: string;
  files: readonly string[];
}

const playwrightCollections: readonly PlaywrightCollection[] = [
  { config: 'playwright.config.ts', files: [] },
  { config: 'playwright.demo.config.ts', files: [] },
  { config: 'playwright.production.config.ts', files: ['e2e/production-report.spec.ts'] },
  { config: 'playwright.session-scroll.config.ts', files: ['e2e/session-scroll.scale.ts'] },
  { config: 'playwright.session-scroll.config.ts', files: ['e2e/session-scroll-benchmark.scale.ts'] },
  { config: 'playwright.svelte-shadow.config.ts', files: ['e2e/svelte-shell.spec.ts'] },
];

const normalizePath = (value: string): string => value.split(path.sep).join('/');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

type FileStatReader = (file: string) => Promise<{ isFile: () => boolean }>;

export const fileExists = async (file: string, readStat: FileStatReader = stat): Promise<boolean> => {
  try {
    return (await readStat(file)).isFile();
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return false;
    }
    throw new Error(`Unable to inspect ${file}.`, { cause: error });
  }
};

const collectFiles = async (directory: string, predicate: (file: string) => boolean): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      if (!ignoredInventoryDirectories.has(entry.name)) {
        files.push(...(await collectFiles(path.join(directory, entry.name), predicate)));
      }
      continue;
    }
    const file = path.join(directory, entry.name);
    if (entry.isFile() && predicate(file)) {
      files.push(file);
    }
  }
  return files;
};

const fixedInventory = (ids: readonly string[]): ReadonlyMap<string, InventoryItem> =>
  new Map(ids.map((id) => [id, {}]));

export const discoverProductionTsx = async (repositoryRoot: string): Promise<ReadonlyMap<string, InventoryItem>> => {
  const roots = [path.join(repositoryRoot, 'apps/web/src'), path.join(repositoryRoot, 'packages/design-system/src')];
  const inventory = new Map<string, InventoryItem>();
  for (const root of roots) {
    for (const file of await collectFiles(root, (candidate) => {
      const name = path.basename(candidate);
      return candidate.endsWith('.tsx') && !(name.endsWith('.test.tsx') || name.endsWith('.spec.tsx'));
    })) {
      const currentOwner = normalizePath(path.relative(repositoryRoot, file));
      inventory.set(`tsx:${currentOwner}`, { currentOwner });
    }
  }
  return inventory;
};

export const discoverServerOperations = async (repositoryRoot: string): Promise<ReadonlyMap<string, InventoryItem>> => {
  const operations = new Map<string, InventoryItem>();
  const sources = await collectFiles(path.join(repositoryRoot, 'apps/web'), (candidate) => {
    const name = path.basename(candidate);
    const isTypeScript = candidate.endsWith('.ts') || candidate.endsWith('.tsx');
    return isTypeScript && !(name.endsWith('.d.ts') || name.includes('.test.') || name.includes('.spec.'));
  });
  for (const file of sources) {
    const currentOwner = normalizePath(path.relative(repositoryRoot, file));
    for (const match of (await readFile(file, 'utf8')).matchAll(serverOperationPattern)) {
      const [name, currentMethod] = [match[1], match[2]];
      if (name && (currentMethod === 'GET' || currentMethod === 'POST')) {
        const id = `op:${name}`;
        if (operations.has(id)) {
          throw new Error(`Duplicate server operation discovered: ${id}`);
        }
        operations.set(id, { currentMethod, currentOwner });
      }
    }
  }
  return operations;
};

const resolveSourceModule = async (importer: string, specifier: string): Promise<string> => {
  const base = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(base);
  const candidates = extension
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve design export ${specifier} from ${importer}`);
};

const exportedDeclarationName = (statement: ts.Statement): string | undefined => {
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text;
  }
  return;
};

const hasExportModifier = (statement: ts.Statement): boolean =>
  (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined)?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;

const discoverSourceExports = async (
  repositoryRoot: string,
  file: string,
  visited = new Set<string>(),
): Promise<ReadonlyMap<string, string>> => {
  const absoluteFile = path.resolve(file);
  if (visited.has(absoluteFile)) {
    return new Map();
  }
  visited.add(absoluteFile);
  const source = await readFile(absoluteFile, 'utf8');
  const sourceFile = ts.createSourceFile(
    absoluteFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    absoluteFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const exports = new Map<string, string>();
  const currentOwner = normalizePath(path.relative(repositoryRoot, absoluteFile));

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const moduleSpecifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      const nested = moduleSpecifier
        ? await discoverSourceExports(repositoryRoot, await resolveSourceModule(absoluteFile, moduleSpecifier), visited)
        : new Map<string, string>();
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const originalName = element.propertyName?.text ?? element.name.text;
          exports.set(element.name.text, nested.get(originalName) ?? currentOwner);
        }
      } else if (!statement.exportClause && moduleSpecifier) {
        for (const [name, owner] of nested) {
          if (!exports.has(name)) {
            exports.set(name, owner);
          }
        }
      }
      continue;
    }

    if (!hasExportModifier(statement)) {
      continue;
    }
    const declarationName = exportedDeclarationName(statement);
    if (declarationName) {
      exports.set(declarationName, currentOwner);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exports.set(declaration.name.text, currentOwner);
        }
      }
    }
  }
  return exports;
};

const exportTarget = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.types === 'string') {
    return value.types;
  }
  if (typeof value.import === 'string') {
    return value.import;
  }
  return;
};

export const discoverDesignExports = async (repositoryRoot: string): Promise<ReadonlyMap<string, InventoryItem>> => {
  const packageJsonPath = path.join(repositoryRoot, 'packages/design-system/package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown;
  if (!(isRecord(packageJson) && isRecord(packageJson.exports))) {
    throw new Error('The design-system package export map is unavailable.');
  }
  const inventory = new Map<string, InventoryItem>();
  for (const [entrypoint, value] of Object.entries(packageJson.exports).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const target = exportTarget(value);
    if (!target) {
      throw new Error(`The design-system export ${entrypoint} has no import or types target.`);
    }
    if (sourceEntrypointPattern.test(target)) {
      const exports = await discoverSourceExports(
        repositoryRoot,
        path.join(repositoryRoot, 'packages/design-system', target),
      );
      for (const [name, currentOwner] of exports) {
        inventory.set(`design-export:${entrypoint}::${name}`, { currentOwner });
      }
      continue;
    }
    const marker = target.endsWith('.css') || target.endsWith('.json') ? '<asset>' : '<module>';
    inventory.set(`design-export:${entrypoint}::${marker}`, {
      currentOwner: 'packages/design-system/package.json',
    });
  }
  return inventory;
};

export const parsePlaywrightListOutput = (output: string): ReadonlyMap<string, InventoryItem> => {
  const inventory = new Map<string, InventoryItem>();
  for (const line of output.split('\n')) {
    const match = playwrightListPattern.exec(line);
    const file = match?.[1];
    const title = match?.[2];
    if (!(file && title)) {
      continue;
    }
    const currentOwner = `apps/web/e2e/${normalizePath(file)}`;
    inventory.set(`pw:${currentOwner}::${title}`, { currentOwner });
  }
  return inventory;
};

export const discoverPlaywrightTitles = async (repositoryRoot: string): Promise<ReadonlyMap<string, InventoryItem>> => {
  const webRoot = path.join(repositoryRoot, 'apps/web');
  const playwrightCli = path.join(repositoryRoot, 'node_modules/@playwright/test/cli.js');
  const inventory = new Map<string, InventoryItem>();
  for (const collection of playwrightCollections) {
    const childProcess = Bun.spawn(
      [process.execPath, '--bun', playwrightCli, 'test', '--config', collection.config, ...collection.files, '--list'],
      { cwd: webRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
      childProcess.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Playwright title discovery failed for ${collection.config}: ${stderr.slice(0, 1000)}`);
    }
    for (const [id, item] of parsePlaywrightListOutput(stdout)) {
      if (inventory.has(id)) {
        throw new Error(`Duplicate Playwright title discovered: ${id}`);
      }
      inventory.set(id, item);
    }
  }
  return inventory;
};

export const discoverRenderSuites = async (repositoryRoot: string): Promise<ReadonlyMap<string, InventoryItem>> => {
  const inventory = new Map<string, InventoryItem>();
  for (const currentOwner of renderSuitePaths) {
    if (await fileExists(path.join(repositoryRoot, currentOwner))) {
      inventory.set(`render:${currentOwner}`, { currentOwner });
    }
  }
  return inventory;
};

export const collectCurrentParityInventory = async (repositoryRoot: string): Promise<CurrentParityInventory> =>
  new Map<ParityKind, ReadonlyMap<string, InventoryItem>>([
    ['feature', fixedInventory(featureIds)],
    ['operation', await discoverServerOperations(repositoryRoot)],
    ['production-tsx', await discoverProductionTsx(repositoryRoot)],
    ['design-row', fixedInventory(designRowIds)],
    ['design-export', await discoverDesignExports(repositoryRoot)],
    ['render-suite', await discoverRenderSuites(repositoryRoot)],
    ['playwright-title', await discoverPlaywrightTitles(repositoryRoot)],
    ['url-contract', fixedInventory(urlContractIds)],
  ]);

const hasValidRecordHeader = (record: Record<string, unknown>): boolean =>
  hasString(record.id) &&
  isParityKind(record.kind) &&
  hasString(record.currentOwner) &&
  isPacketId(record.targetOwner) &&
  isParityStatus(record.status) &&
  Array.isArray(record.evidence) &&
  record.evidence.length > 0;

const recordFieldIssues = (record: Record<string, unknown>, location: string): readonly string[] => {
  const issues: string[] = [];
  if (!hasString(record.id)) {
    issues.push(`${location} has no stable id.`);
  }
  if (!isParityKind(record.kind)) {
    issues.push(`${location} has an unsupported kind.`);
  }
  if (!hasString(record.currentOwner)) {
    issues.push(`${location} has no currentOwner.`);
  }
  if (!isPacketId(record.targetOwner)) {
    issues.push(`${location} has no valid targetOwner.`);
  }
  if (!isParityStatus(record.status)) {
    issues.push(`${location} has an unsupported status.`);
  }
  if (!(Array.isArray(record.evidence) && record.evidence.length > 0)) {
    issues.push(`${location} has no evidence.`);
  }
  return issues;
};

const isValidEvidence = (value: unknown): value is ParityEvidence =>
  isRecord(value) &&
  typeof value.commit === 'string' &&
  commitPattern.test(value.commit) &&
  isEvidenceKind(value.kind) &&
  isEvidencePhase(value.phase) &&
  hasString(value.reference);

const evidenceIssues = (record: ParityRecord, location: string, commits: Set<string>): readonly string[] => {
  const issues: string[] = [];
  for (const [index, value] of (record.evidence as readonly unknown[]).entries()) {
    if (!isRecord(value)) {
      issues.push(`${location} evidence ${index} is not an object.`);
      continue;
    }
    if (typeof value.commit === 'string' && commitPattern.test(value.commit)) {
      commits.add(value.commit);
    } else {
      issues.push(`${location} evidence ${index} has an invalid commit.`);
    }
    if (!isEvidenceKind(value.kind)) {
      issues.push(`${location} evidence ${index} has an invalid kind.`);
    }
    if (!isEvidencePhase(value.phase)) {
      issues.push(`${location} evidence ${index} has an invalid phase.`);
    }
    if (!hasString(value.reference)) {
      issues.push(`${location} evidence ${index} has no reference.`);
    }
  }
  return issues;
};

const hasTargetEvidence = (record: ParityRecord, kind?: ParityEvidence['kind']): boolean =>
  (record.evidence as readonly unknown[]).some(
    (value) =>
      isValidEvidence(value) &&
      value.phase === 'target' &&
      value.commit !== baselineEvidenceCommit &&
      (kind === undefined || value.kind === kind),
  );

const descriptorIssues = (record: ParityRecord, location: string): readonly string[] => {
  const issues: string[] = [];
  const operationValue = record.operation as unknown;
  if (record.kind === 'operation') {
    if (!isRecord(operationValue)) {
      return [`${location} has no valid operation descriptor.`];
    }
    if (!(operationValue.currentMethod === 'GET' || operationValue.currentMethod === 'POST')) {
      issues.push(`${location} has an invalid current method.`);
    }
    for (const [field, value] of Object.entries({
      implementationOwner: operationValue.implementationOwner,
      inputParser: operationValue.inputParser,
      outputParser: operationValue.outputParser,
      target: operationValue.target,
    })) {
      if (!hasString(value)) {
        issues.push(`${location} operation ${field} is empty.`);
      }
    }
    if (
      !(
        Array.isArray(operationValue.publicErrors) &&
        operationValue.publicErrors.length > 0 &&
        operationValue.publicErrors.every(hasString)
      )
    ) {
      issues.push(`${location} has no closed public error inventory.`);
    }
    if (
      !(
        operationValue.transport === 'query' ||
        operationValue.transport === 'mutation' ||
        operationValue.transport === 'file'
      )
    ) {
      issues.push(`${location} has an invalid operation transport.`);
    }
  } else if (operationValue !== undefined) {
    issues.push(`${location} has an operation descriptor for ${record.kind}.`);
  }

  const urlValue = record.urlContract as unknown;
  if (record.kind === 'url-contract') {
    if (!isRecord(urlValue)) {
      return [...issues, `${location} has no valid URL contract descriptor.`];
    }
    for (const [field, value] of Object.entries({
      canonical: urlValue.canonical,
      defaultValue: urlValue.defaultValue,
      lifecycle: urlValue.lifecycle,
    })) {
      if (!hasString(value)) {
        issues.push(`${location} URL ${field} is empty.`);
      }
    }
    if (!(Array.isArray(urlValue.legacyValues) && urlValue.legacyValues.every(hasString))) {
      issues.push(`${location} has no URL legacy-values inventory.`);
    }
  } else if (urlValue !== undefined) {
    issues.push(`${location} has a URL contract descriptor for ${record.kind}.`);
  }

  return issues;
};

export const validateParityShards = async (
  loadedShards: readonly LoadedParityShard[],
  inventory: CurrentParityInventory,
  options: ValidateParityOptions,
): Promise<ParityCheckResult> => {
  const issues: string[] = [];
  const recordsById = new Map<string, { file: string; record: ParityRecord }>();
  const recordsByKind = new Map<ParityKind, Map<string, ParityRecord>>(parityKinds.map((kind) => [kind, new Map()]));
  const evidenceCommits = new Set<string>();

  for (const loaded of loadedShards) {
    const shard = asParityShard(loaded.shard);
    if (!shard) {
      issues.push(`${loaded.file} does not export a parity shard.`);
      continue;
    }
    const expectedPrefix = `${shard.owner.toLowerCase()}.`;
    if (!(loaded.file === `${shard.owner.toLowerCase()}.parity.ts` || loaded.file.startsWith(expectedPrefix))) {
      issues.push(`${loaded.file} crosses shard ownership for ${shard.owner}.`);
    }
    for (const [index, value] of (shard.records as readonly unknown[]).entries()) {
      const location = `${loaded.file} record ${index}`;
      if (!isRecord(value)) {
        issues.push(`${location} is not an object.`);
        continue;
      }
      issues.push(...recordFieldIssues(value, location));
      if (!hasValidRecordHeader(value)) {
        continue;
      }
      const record = value as unknown as ParityRecord;
      if (record.targetOwner !== shard.owner) {
        issues.push(`${location} is owned by ${record.targetOwner}, not shard ${shard.owner}.`);
      }
      const existing = recordsById.get(record.id);
      if (existing) {
        issues.push(`${location} duplicates ${record.id} from ${existing.file}.`);
      } else {
        recordsById.set(record.id, { file: loaded.file, record });
        recordsByKind.get(record.kind)?.set(record.id, record);
      }
      if (record.status === 'reviewed-removal') {
        if (record.kind === 'feature') {
          issues.push(`${location} cannot remove a required feature ID.`);
        }
        if (!hasString(record.replacementReason)) {
          issues.push(`${location} is an unsupported removal without a reviewed replacementReason.`);
        }
        if (!hasTargetEvidence(record, 'review')) {
          issues.push(`${location} has no integrated target review evidence for its removal.`);
        }
      } else if (record.replacementReason !== undefined) {
        issues.push(`${location} has a replacementReason without reviewed-removal status.`);
      }
      if (record.status === 'complete' && !hasTargetEvidence(record)) {
        issues.push(`${location} is complete without integrated target evidence.`);
      }
      if (record.status === 'complete' && !hasTargetEvidence(record, 'review')) {
        issues.push(`${location} is complete without integrated target review evidence.`);
      }
      if (options.requireComplete && record.status === 'current') {
        issues.push(`${location} remains current at the complete-only gate.`);
      }
      issues.push(...evidenceIssues(record, location, evidenceCommits));
      issues.push(...descriptorIssues(record, location));
    }
  }

  for (const commit of [...evidenceCommits].sort()) {
    if (!(await options.integratedEvidence(commit))) {
      issues.push(`Evidence commit ${commit} is not integrated into the checked HEAD.`);
    }
  }

  const counts = new Map<ParityKind, ParityKindCount>();
  for (const kind of parityKinds) {
    const liveItems = inventory.get(kind) ?? new Map();
    const ledgerItems = recordsByKind.get(kind) ?? new Map();
    let owned = 0;
    for (const [id, live] of liveItems) {
      const record = ledgerItems.get(id);
      if (!record) {
        issues.push(`Missing ${kind} ledger record for ${id}.`);
        continue;
      }
      owned += 1;
      if (live.currentOwner && record.status === 'current' && record.currentOwner !== live.currentOwner) {
        issues.push(`${id} currentOwner is ${record.currentOwner}, expected ${live.currentOwner}.`);
      }
      if (
        kind === 'operation' &&
        live.currentMethod &&
        record.status === 'current' &&
        record.operation?.currentMethod !== live.currentMethod
      ) {
        issues.push(
          `${id} current method is ${record.operation?.currentMethod ?? 'missing'}, expected ${live.currentMethod}.`,
        );
      }
      if (record.status === 'reviewed-removal') {
        issues.push(`${id} is marked removed but still exists in the current inventory.`);
      }
    }
    for (const [id, record] of ledgerItems) {
      if (!liveItems.has(id) && record.status === 'current') {
        issues.push(`Stale current ${kind} record ${id} has no discovered inventory item.`);
      }
    }
    counts.set(kind, { ledger: ledgerItems.size, live: liveItems.size, owned });
  }

  return { counts, issues };
};

const integratedIntoHead = async (repositoryRoot: string, commit: string): Promise<boolean> => {
  const process = Bun.spawn(['git', 'merge-base', '--is-ancestor', commit, 'HEAD'], {
    cwd: repositoryRoot,
    stderr: 'ignore',
    stdout: 'ignore',
  });
  return (await process.exited) === 0;
};

export const checkWebMigrationParity = async (
  repositoryRoot: string,
  options: { requireComplete?: boolean } = {},
): Promise<ParityCheckResult> => {
  const [loadedShards, inventory] = await Promise.all([
    loadParityShards(repositoryRoot),
    collectCurrentParityInventory(repositoryRoot),
  ]);
  return await validateParityShards(loadedShards, inventory, {
    integratedEvidence: async (commit) => await integratedIntoHead(repositoryRoot, commit),
    ...(options.requireComplete === undefined ? {} : { requireComplete: options.requireComplete }),
  });
};

const reportResult = (result: ParityCheckResult): void => {
  for (const kind of parityKinds) {
    const count = result.counts.get(kind);
    if (count) {
      process.stdout.write(
        `${kind}: ${count.owned}/${count.live} current inventory owned; ${count.ledger} ledger records\n`,
      );
    }
  }
  if (result.issues.length === 0) {
    process.stdout.write('Web migration parity inventory is complete for the current gate.\n');
    return;
  }
  process.stderr.write('Web migration parity check failed.\n');
  for (const issue of result.issues) {
    process.stderr.write(`- ${issue}\n`);
  }
  process.exitCode = 1;
};

if (import.meta.main) {
  reportResult(
    await checkWebMigrationParity(process.cwd(), {
      requireComplete: process.argv.includes('--require-complete'),
    }),
  );
}
