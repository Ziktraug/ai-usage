#!/usr/bin/env bun
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const rootDir = path.resolve(import.meta.dir, '../../..');
const reportDir = path.resolve(rootDir, 'apps/web');
const cliEntry = path.resolve(import.meta.dir, 'main.ts');
const outputDir = path.resolve(rootDir, 'ai-usage-reports');

const usage = `Usage:
  bun run html export [report options]

Examples:
  bun run html export
  bun run html export --since 30d --limit 20

Creates a dated single-file HTML report in ./ai-usage-reports/.`;

const timestampForFilename = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');

const run = async () => {
  const [command, ...reportArgs] = Bun.argv.slice(2);

  if (command === '--help' || command === '-h') {
    console.log(usage);
    return 0;
  }

  if (command !== 'export') {
    console.error(usage);
    return 1;
  }

  console.log('Building report app...');
  await execFileAsync('bun', ['run', '--cwd', reportDir, 'build'], {
    cwd: rootDir,
    maxBuffer: 64 * 1024 * 1024,
  });

  console.log('Collecting usage data...');
  const { stdout } = await execFileAsync('bun', [cliEntry, '--html', ...reportArgs], {
    cwd: rootDir,
    maxBuffer: 256 * 1024 * 1024,
  });

  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `ai-usage-report-${timestampForFilename(new Date())}.html`);
  await writeFile(outputPath, stdout);

  console.log(`Wrote ${path.relative(rootDir, outputPath)}`);
  return 0;
};

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
