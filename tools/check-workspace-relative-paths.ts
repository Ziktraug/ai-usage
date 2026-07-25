import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ignoredDirectories = new Set(['.git', '.turbo', '.output', 'dist', 'node_modules', 'styled-system']);
const ignoredFiles = new Set(['biome.json']);
const checkedExtensions = new Set(['.cjs', '.js', '.jsx', '.json', '.mjs', '.ts', '.tsx', '.yaml', '.yml']);
const relativeWorkspacePath = /\.\.\/(?:\.\.\/)*(?:apps|packages)\//g;

interface Violation {
  column: number;
  file: string;
  line: number;
  match: string;
}

const root = process.cwd();

async function collectViolations(directory: string): Promise<Violation[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const violations: Violation[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        violations.push(...(await collectViolations(path.join(directory, entry.name))));
      }
      continue;
    }

    if (!entry.isFile() || ignoredFiles.has(entry.name) || !checkedExtensions.has(path.extname(entry.name))) {
      continue;
    }

    const file = path.join(directory, entry.name);
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(relativeWorkspacePath)) {
      const index = match.index;
      const before = text.slice(0, index);
      const line = before.split('\n').length;
      const lastNewline = before.lastIndexOf('\n');
      const column = index - lastNewline;
      violations.push({ column, file: path.relative(root, file), line, match: match[0] });
    }
  }

  return violations;
}

const violations = await collectViolations(root);

if (violations.length > 0) {
  console.error(
    'Relative workspace paths are not allowed. Use package-manager workspace commands or public package exports.',
  );
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.match}`);
  }
  process.exitCode = 1;
}
