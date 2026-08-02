import path from 'node:path';
import ts from 'typescript';

export const TYPECHECK_PROJECTS = [
  'apps/cli/tsconfig.json',
  'apps/usage-engine/tsconfig.json',
  'apps/web/tsconfig.json',
  'apps/web/tsconfig.e2e.json',
  'apps/web/tsconfig.server.json',
  'packages/design-system/tsconfig.json',
  'packages/effect-runtime/tsconfig.json',
  'packages/local-collectors/tsconfig.json',
  'packages/local-machine/tsconfig.json',
  'packages/report-core/tsconfig.json',
  'packages/report-data/tsconfig.json',
  'packages/skills/tsconfig.json',
  'packages/usage-engine-control/tsconfig.json',
  'packages/usage-engine-runtime/tsconfig.json',
  'packages/usage-merge/tsconfig.json',
  'packages/usage-store/tsconfig.json',
  'tsconfig.tools.json',
] as const;

const SUPPLEMENTAL_TYPECHECK_CONFIG = 'tsconfig.tools.json';
export const SUPPLEMENTAL_TYPECHECK_PREFIXES = ['apps/web/migration-parity/'] as const;

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};

const normalizeRelativePath = (root: string, fileName: string): string =>
  path.relative(root, fileName).split(path.sep).join('/');

export const findUncoveredTypeScriptFiles = (
  repositoryFiles: readonly string[],
  projectFiles: ReadonlySet<string>,
): string[] => repositoryFiles.filter((fileName) => !projectFiles.has(fileName)).sort();

export const filterExistingRepositoryFiles = (
  root: string,
  repositoryFiles: readonly string[],
  fileExists: (fileName: string) => boolean = ts.sys.fileExists,
): string[] => repositoryFiles.filter((fileName) => fileExists(path.resolve(root, fileName)));

export const selectSupplementalTypeScriptFiles = (repositoryFiles: readonly string[]): string[] =>
  repositoryFiles.filter((fileName) => SUPPLEMENTAL_TYPECHECK_PREFIXES.some((prefix) => fileName.startsWith(prefix)));

export const listRepositoryTypeScriptFiles = (root: string): string[] => {
  const result = Bun.spawnSync({
    cmd: ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'],
    cwd: root,
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || 'Unable to list repository TypeScript files.');
  }
  const repositoryFiles = new TextDecoder().decode(result.stdout).trim().split('\n').filter(Boolean).sort();
  return filterExistingRepositoryFiles(root, repositoryFiles);
};

export const listTypeScriptProjectFiles = (
  root: string,
  projectConfigs: readonly string[],
  supplementalFiles: readonly string[] = [],
): Set<string> => {
  const projectFiles = new Set<string>();

  for (const projectConfig of projectConfigs) {
    const configPath = path.resolve(root, projectConfig);
    const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configResult.error) {
      throw new Error(ts.formatDiagnostic(configResult.error, formatHost));
    }
    const parsedConfig = ts.parseJsonConfigFileContent(
      configResult.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
    if (parsedConfig.errors.length > 0) {
      throw new Error(ts.formatDiagnostics(parsedConfig.errors, formatHost));
    }
    const supplementalRootNames =
      projectConfig === SUPPLEMENTAL_TYPECHECK_CONFIG
        ? supplementalFiles.map((fileName) => path.resolve(root, fileName))
        : [];
    const program = ts.createProgram({
      options: parsedConfig.options,
      ...(parsedConfig.projectReferences === undefined ? {} : { projectReferences: parsedConfig.projectReferences }),
      rootNames: [...new Set([...parsedConfig.fileNames, ...supplementalRootNames])],
    });
    if (supplementalRootNames.length > 0) {
      const diagnostics = ts.getPreEmitDiagnostics(program);
      if (diagnostics.length > 0) {
        throw new Error(ts.formatDiagnostics(diagnostics, formatHost));
      }
    }
    for (const sourceFile of program.getSourceFiles()) {
      const fileName = sourceFile.fileName;
      const relativePath = normalizeRelativePath(root, fileName);
      if (!relativePath.startsWith('../')) {
        projectFiles.add(relativePath);
      }
    }
  }

  return projectFiles;
};

export const collectUncoveredTypeScriptFiles = (
  root: string,
  projectConfigs: readonly string[] = TYPECHECK_PROJECTS,
): string[] => {
  const repositoryFiles = listRepositoryTypeScriptFiles(root);
  const supplementalFiles = selectSupplementalTypeScriptFiles(repositoryFiles);
  return findUncoveredTypeScriptFiles(
    repositoryFiles,
    listTypeScriptProjectFiles(root, projectConfigs, supplementalFiles),
  );
};

if (import.meta.main) {
  const uncoveredFiles = collectUncoveredTypeScriptFiles(process.cwd());
  if (uncoveredFiles.length > 0) {
    console.error('Every TypeScript file must belong to a project executed by `bun run typecheck`.');
    for (const fileName of uncoveredFiles) {
      console.error(`- ${fileName}`);
    }
    process.exitCode = 1;
  }
}
