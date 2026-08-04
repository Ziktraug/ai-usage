import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const svelteKitPhases = ['build', 'check', 'dev'] as const;

export type SvelteKitPhase = (typeof svelteKitPhases)[number];

export interface SvelteKitOutputPaths {
  adapterDirectory: string;
  intermediateDirectory: string;
  phase: SvelteKitPhase;
  viteCacheDirectory: string;
}

const isCompleteGitRevision = (value: string): boolean =>
  value.length === 40 && [...value].every((character) => '0123456789abcdef'.includes(character));

export const resolveSvelteKitVersionName = (
  repositoryDirectory: string = path.resolve(import.meta.dirname, '../..'),
): string => {
  const versionName = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!isCompleteGitRevision(versionName)) {
    throw new Error('SvelteKit build version must be a complete Git revision.');
  }
  return versionName;
};

const isSvelteKitPhase = (value: string): value is SvelteKitPhase =>
  svelteKitPhases.some((candidate) => candidate === value);

export const resolveSvelteKitOutputPaths = (
  requestedPhase: string | undefined = process.env.AI_USAGE_SVELTEKIT_PHASE,
): SvelteKitOutputPaths => {
  const phase = requestedPhase ?? 'check';
  if (!isSvelteKitPhase(phase)) {
    throw new Error(`Invalid SvelteKit phase: ${phase}`);
  }

  const intermediateDirectory = `.svelte-kit/${phase}`;
  return {
    adapterDirectory: phase === 'build' ? '.output-build/sveltekit' : `${intermediateDirectory}/adapter-bun`,
    intermediateDirectory,
    phase,
    viteCacheDirectory: `${intermediateDirectory}/vite`,
  };
};
