import fs from 'node:fs';
import path from 'node:path';

const ROOT_MANIFEST_NAME = 'package.json';
const FOCUSED_REPORT_QUERY_RUNNER_PATH = 'packages/report-data/src/focused-report-query-runner.ts';
const KNOWN_PROJECT_SOURCES_RUNNER_PATH = 'packages/report-data/src/known-project-sources-runner.ts';
const REPORT_PAYLOAD_RUNNER_PATH = 'packages/report-data/src/report-payload-runner.ts';
const SESSION_QUERY_MATERIALIZE_RUNNER_PATH = 'packages/report-data/src/session-query-materialize-runner.ts';
const SESSION_QUERY_RUNNER_PATH = 'packages/report-data/src/session-query-runner.ts';

export interface ReportRuntimePaths {
  focusedReportQueryRunner: string;
  knownProjectSourcesRunner: string;
  reportingPayloadRunner: string;
  rootDir: string;
  rootEnvPath: string;
  sessionQueryMaterializeRunner: string;
  sessionQueryRunner: string;
}

export interface ResolveReportRuntimePathsOptions {
  configuredRoot?: string | null;
  cwd: string;
}

const isRegularFile = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const runtimePathsForRoot = (rootDir: string): ReportRuntimePaths => ({
  focusedReportQueryRunner: path.join(rootDir, FOCUSED_REPORT_QUERY_RUNNER_PATH),
  knownProjectSourcesRunner: path.join(rootDir, KNOWN_PROJECT_SOURCES_RUNNER_PATH),
  rootDir,
  reportingPayloadRunner: path.join(rootDir, REPORT_PAYLOAD_RUNNER_PATH),
  rootEnvPath: path.join(rootDir, '.env'),
  sessionQueryMaterializeRunner: path.join(rootDir, SESSION_QUERY_MATERIALIZE_RUNNER_PATH),
  sessionQueryRunner: path.join(rootDir, SESSION_QUERY_RUNNER_PATH),
});

const isValidRuntimeRoot = (paths: ReportRuntimePaths): boolean =>
  isRegularFile(path.join(paths.rootDir, ROOT_MANIFEST_NAME)) &&
  isRegularFile(paths.focusedReportQueryRunner) &&
  isRegularFile(paths.knownProjectSourcesRunner) &&
  isRegularFile(paths.reportingPayloadRunner) &&
  isRegularFile(paths.sessionQueryMaterializeRunner) &&
  isRegularFile(paths.sessionQueryRunner);

const invalidRootError = (paths: ReportRuntimePaths): Error =>
  new Error(
    `Invalid ai-usage workspace root: ${paths.rootDir}. Expected regular files: ${path.join(paths.rootDir, ROOT_MANIFEST_NAME)}, ${paths.focusedReportQueryRunner}, ${paths.knownProjectSourcesRunner}, ${paths.reportingPayloadRunner}, ${paths.sessionQueryMaterializeRunner}, and ${paths.sessionQueryRunner}.`,
  );

export const resolveReportRuntimePaths = ({
  configuredRoot,
  cwd,
}: ResolveReportRuntimePathsOptions): ReportRuntimePaths => {
  if (configuredRoot !== undefined && configuredRoot !== null && configuredRoot !== '') {
    const configuredPaths = runtimePathsForRoot(path.resolve(cwd, configuredRoot));
    if (!isValidRuntimeRoot(configuredPaths)) {
      throw invalidRootError(configuredPaths);
    }
    return configuredPaths;
  }

  let candidateRoot = path.resolve(cwd);
  while (true) {
    const candidatePaths = runtimePathsForRoot(candidateRoot);
    if (isValidRuntimeRoot(candidatePaths)) {
      return candidatePaths;
    }
    const parent = path.dirname(candidateRoot);
    if (parent === candidateRoot) {
      throw new Error(
        `Unable to discover the ai-usage workspace from ${path.resolve(cwd)}. Expected ${ROOT_MANIFEST_NAME}, ${FOCUSED_REPORT_QUERY_RUNNER_PATH}, ${KNOWN_PROJECT_SOURCES_RUNNER_PATH}, ${REPORT_PAYLOAD_RUNNER_PATH}, ${SESSION_QUERY_MATERIALIZE_RUNNER_PATH}, and ${SESSION_QUERY_RUNNER_PATH} as regular files in an ancestor directory.`,
      );
    }
    candidateRoot = parent;
  }
};
