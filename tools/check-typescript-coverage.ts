import path from 'node:path';
import ts from 'typescript';

export const TYPECHECK_PROJECTS = [
  'apps/cli/tsconfig.json',
  'apps/mcp/tsconfig.json',
  'apps/server/tsconfig.json',
  'apps/usage-engine/tsconfig.json',
  'apps/web/tsconfig.json',
  'apps/web/tsconfig.e2e.json',
  'packages/authorization/tsconfig.json',
  'packages/authorization-contract/tsconfig.json',
  'packages/design-system/tsconfig.json',
  'packages/effect-runtime/tsconfig.json',
  'packages/identity/tsconfig.json',
  'packages/local-collectors/tsconfig.json',
  'packages/local-machine/tsconfig.json',
  'packages/mcp-adapter/tsconfig.json',
  'packages/memory-sqlite/tsconfig.json',
  'packages/memory-search/tsconfig.json',
  'packages/memory-service/tsconfig.json',
  'packages/platform-core/tsconfig.json',
  'packages/postgres-store/tsconfig.json',
  'packages/project-application/tsconfig.json',
  'packages/project-registry/tsconfig.json',
  'packages/replication-client/tsconfig.json',
  'packages/replication-outbox/tsconfig.json',
  'packages/replication-protocol/tsconfig.json',
  'packages/report-core/tsconfig.json',
  'packages/report-data/tsconfig.json',
  'packages/skills/tsconfig.json',
  'packages/usage-engine-control/tsconfig.json',
  'packages/usage-engine-runtime/tsconfig.json',
  'packages/usage-merge/tsconfig.json',
  'packages/usage-store/tsconfig.json',
  'packages/web-contract/tsconfig.json',
  'tsconfig.tools.json',
] as const;

export const needsTransitiveProjectDiscovery = (
  repositoryFiles: readonly string[] | undefined,
  projectFiles: ReadonlySet<string>,
): boolean => repositoryFiles === undefined || repositoryFiles.some((fileName) => !projectFiles.has(fileName));

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
  repositoryFiles?: readonly string[],
): Set<string> => {
  const projectFiles = new Set<string>();
  const transitiveProjects: ts.ParsedCommandLine[] = [];

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
    for (const fileName of parsedConfig.fileNames) {
      const relativePath = normalizeRelativePath(root, fileName);
      if (!relativePath.startsWith('../')) {
        projectFiles.add(relativePath);
      }
    }
    transitiveProjects.push(parsedConfig);
  }

  if (needsTransitiveProjectDiscovery(repositoryFiles, projectFiles)) {
    for (const parsedConfig of transitiveProjects) {
      const program = ts.createProgram({
        options: parsedConfig.options,
        ...(parsedConfig.projectReferences === undefined ? {} : { projectReferences: parsedConfig.projectReferences }),
        rootNames: parsedConfig.fileNames,
      });
      for (const sourceFile of program.getSourceFiles()) {
        const relativePath = normalizeRelativePath(root, sourceFile.fileName);
        if (!relativePath.startsWith('../')) {
          projectFiles.add(relativePath);
        }
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
  return findUncoveredTypeScriptFiles(
    repositoryFiles,
    listTypeScriptProjectFiles(root, projectConfigs, repositoryFiles),
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
