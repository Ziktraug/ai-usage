#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTROL_BUNDLE_MAP_PATH = path.join(ROOT, 'docs/performance/artifacts/plan072-control-bundle-map.json');
const CONTROL_DESTINATION_PATH = path.join(ROOT, 'docs/performance/artifacts/plan072-ark-control-7.json');
const DESTINATION_PATH = path.join(ROOT, 'docs/performance/artifacts/plan072-destination-render.json');
const BUNDLE_MAP_PATH = path.join(ROOT, 'docs/performance/artifacts/plan072-bundle-map-rejected-b.json');
const OUTPUT_PATH = path.join(ROOT, 'docs/performance/artifacts/plan072-ark-split.json');
const CLIENT_DIRECTORY = path.join(ROOT, 'apps/web/.output-build/sveltekit/client');
const LEADING_SLASH_PATTERN = /^\/+/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (raw: string, label: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to contain a JSON object`);
  }
  return value;
};

const requiredRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
};

const requiredNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected ${label} to be a finite number`);
  }
  return value;
};

const requiredStringArray = (value: unknown, label: string): readonly string[] => {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
    throw new Error(`Expected ${label} to be an array of strings`);
  }
  return value;
};

const findDestinationClosure = (root: Record<string, unknown>, label: string): Record<string, unknown> => {
  if (!Array.isArray(root.destinationClosures)) {
    throw new Error('Expected bundleMap.destinationClosures to be an array');
  }
  const closure = root.destinationClosures.find((value) => isRecord(value) && value.label === label);
  return requiredRecord(closure, `bundleMap.destinationClosures.${label}`);
};

interface DrawerSample {
  readonly bytesLoadedAfterDrawerOpen: number;
  readonly drawerOpenMs: number;
  readonly newChunkFileNames: readonly string[];
}

const parseDrawerSamples = (root: Record<string, unknown>, label: string): readonly DrawerSample[] => {
  const destination = requiredRecord(root.plan072DestinationRender, `${label}.plan072DestinationRender`);
  if (!Array.isArray(destination.drawer) || destination.drawer.length < 3 || destination.drawer.length % 2 === 0) {
    throw new Error(`Expected ${label} to contain an odd number of at least three Drawer samples`);
  }
  return destination.drawer.map((value, index) => {
    const sample = requiredRecord(value, `${label}.drawer[${index}]`);
    return {
      bytesLoadedAfterDrawerOpen: requiredNumber(
        sample.bytesLoadedAfterDrawerOpen,
        `${label}.drawer[${index}].bytesLoadedAfterDrawerOpen`,
      ),
      drawerOpenMs: requiredNumber(sample.drawerOpenMs, `${label}.drawer[${index}].drawerOpenMs`),
      newChunkFileNames: requiredStringArray(sample.newChunkFileNames, `${label}.drawer[${index}].newChunkFileNames`),
    };
  });
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const percentage = (delta: number, control: number): number => Number(((delta / control) * 100).toFixed(6));

const delta = (control: number, candidate: number): { bytes: number; percent: number } => ({
  bytes: candidate - control,
  percent: percentage(candidate - control, control),
});

const compressedBytes = (body: Buffer): { brotli: number; gzip: number; raw: number } => ({
  brotli: brotliCompressSync(body).byteLength,
  gzip: gzipSync(body, { level: 9 }).byteLength,
  raw: body.byteLength,
});

const candidateIncremental = (samples: readonly DrawerSample[]): { gzip: number; raw: number } => {
  const measurements = samples.map((sample) => {
    let raw = 0;
    let gzip = 0;
    for (const fileName of sample.newChunkFileNames) {
      const body = readFileSync(path.join(CLIENT_DIRECTORY, fileName));
      const compressed = compressedBytes(body);
      raw += compressed.raw;
      gzip += compressed.gzip;
    }
    if (raw !== sample.bytesLoadedAfterDrawerOpen) {
      throw new Error(
        `Candidate Drawer artifact reports ${sample.bytesLoadedAfterDrawerOpen} raw bytes; built files total ${raw}`,
      );
    }
    return { gzip, raw };
  });
  const first = measurements[0];
  if (!first || measurements.some((measurement) => measurement.raw !== first.raw || measurement.gzip !== first.gzip)) {
    throw new Error('Expected all candidate Drawer samples to load the same raw and gzip byte totals');
  }
  return first;
};

const deriveControlDrawerGzip = (
  controlClientDirectory: string,
  samples: readonly DrawerSample[],
): { files: readonly string[]; gzip: number; raw: number } => {
  const firstSample = samples[0];
  if (!firstSample) {
    throw new Error('Expected at least one control Drawer sample');
  }
  const files = firstSample.newChunkFileNames.map((fileName) => fileName.replace(LEADING_SLASH_PATTERN, ''));
  if (samples.some((sample) => sample.newChunkFileNames.join('\n') !== firstSample.newChunkFileNames.join('\n'))) {
    throw new Error('Expected every control Drawer sample to report the same chunk identities');
  }
  let raw = 0;
  let gzip = 0;
  for (const fileName of files) {
    const body = readFileSync(path.join(controlClientDirectory, fileName));
    raw += body.byteLength;
    gzip += gzipSync(body, { level: 9 }).byteLength;
  }
  if (raw !== firstSample.bytesLoadedAfterDrawerOpen) {
    throw new Error(
      `Control Drawer artifact reports ${firstSample.bytesLoadedAfterDrawerOpen} raw bytes; built files total ${raw}`,
    );
  }
  return { files, gzip, raw };
};

const main = (): void => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const controlBundleMap = parseJson(readFileSync(CONTROL_BUNDLE_MAP_PATH, 'utf8'), 'plan072-control-bundle-map.json');
  const controlInitial = findDestinationClosure(controlBundleMap, 'overview');
  const controlDestination = parseJson(readFileSync(CONTROL_DESTINATION_PATH, 'utf8'), 'plan072-ark-control-7.json');
  const candidateDestination = parseJson(readFileSync(DESTINATION_PATH, 'utf8'), 'plan072-destination-render.json');
  const bundleMap = parseJson(readFileSync(BUNDLE_MAP_PATH, 'utf8'), 'plan072-bundle-map-rejected-b.json');
  const duplicatedArkOrZagCount = requiredNumber(
    bundleMap.duplicatedArkOrZagCount,
    'bundleMap.duplicatedArkOrZagCount',
  );
  const controlDrawerSamples = parseDrawerSamples(controlDestination, 'control destination');
  const candidateDrawerSamples = parseDrawerSamples(candidateDestination, 'candidate destination');
  const controlDrawerRaw = controlDrawerSamples[0]?.bytesLoadedAfterDrawerOpen ?? 0;
  if (controlDrawerSamples.some((sample) => sample.bytesLoadedAfterDrawerOpen !== controlDrawerRaw)) {
    throw new Error('Expected all control Drawer samples to load the same raw bytes');
  }

  // biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit path to the clean control build used for compression evidence
  const controlClientDirectory = process.env.AI_USAGE_PLAN072_CONTROL_CLIENT_DIR;
  if (!controlClientDirectory) {
    throw new Error('AI_USAGE_PLAN072_CONTROL_CLIENT_DIR must point to a clean HEAD control client build');
  }
  const controlDrawerGzip = deriveControlDrawerGzip(controlClientDirectory, controlDrawerSamples);
  const candidateInitial = findDestinationClosure(bundleMap, 'overview');
  const candidateDrawer = candidateIncremental(candidateDrawerSamples);
  const initial = {
    control: {
      brotli: requiredNumber(controlInitial.brotliBytes, 'control.initialStaticClosure.brotliBytes'),
      gzip: requiredNumber(controlInitial.gzipBytes, 'control.initialStaticClosure.gzipBytes'),
      raw: requiredNumber(controlInitial.rawBytes, 'control.initialStaticClosure.rawBytes'),
    },
    candidate: {
      brotli: requiredNumber(candidateInitial.brotliBytes, 'candidateInitial.brotliBytes'),
      gzip: requiredNumber(candidateInitial.gzipBytes, 'candidateInitial.gzipBytes'),
      raw: requiredNumber(candidateInitial.rawBytes, 'candidateInitial.rawBytes'),
    },
  };
  const incrementalDrawer = {
    control: { gzip: controlDrawerGzip.gzip, raw: controlDrawerRaw },
    candidate: candidateDrawer,
  };
  const totalThroughDrawer = {
    control: {
      gzip: initial.control.gzip + incrementalDrawer.control.gzip,
      raw: initial.control.raw + incrementalDrawer.control.raw,
    },
    candidate: {
      gzip: initial.candidate.gzip + incrementalDrawer.candidate.gzip,
      raw: initial.candidate.raw + incrementalDrawer.candidate.raw,
    },
  };
  const initialGzipDelta = delta(initial.control.gzip, initial.candidate.gzip);
  const totalGzipDelta = delta(totalThroughDrawer.control.gzip, totalThroughDrawer.candidate.gzip);
  const controlDrawerOpenMedian = median(controlDrawerSamples.map((sample) => sample.drawerOpenMs));
  const candidateDrawerOpenMedian = median(candidateDrawerSamples.map((sample) => sample.drawerOpenMs));
  const drawerOpenDelta = delta(controlDrawerOpenMedian, candidateDrawerOpenMedian);
  const webPackage = parseJson(readFileSync(path.join(ROOT, 'apps/web/package.json'), 'utf8'), 'apps/web/package.json');
  const webDependencies = requiredRecord(webPackage.dependencies, 'apps/web.dependencies');
  const webDevDependencies = requiredRecord(webPackage.devDependencies, 'apps/web.devDependencies');
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      artifactSourceCommit: head,
      worktreeHead: head,
      worktreeDirty: status.length > 0,
    },
    tools: {
      bun: Bun.version,
      chrome: execFileSync(Bun.which('google-chrome') ?? 'google-chrome', ['--version'], { encoding: 'utf8' }).trim(),
      arkUiSvelte: webDependencies['@ark-ui/svelte'],
      playwright: webDevDependencies['@playwright/test'],
      svelte: webDependencies.svelte,
      svelteKit: webDevDependencies['@sveltejs/kit'],
      vite: webDevDependencies.vite,
    },
    sources: {
      controlBundleMap: 'docs/performance/artifacts/plan072-control-bundle-map.json',
      controlDrawer: 'docs/performance/artifacts/plan072-ark-control-7.json',
      candidateBundleMap: 'docs/performance/artifacts/plan072-bundle-map-rejected-b.json',
      candidateDestination: 'docs/performance/artifacts/plan072-destination-render.json',
    },
    method: {
      initial:
        'Control and candidate bytes are recomputed from their clean-build Vite Overview closures with gzip level 9 and default Brotli.',
      incrementalDrawer:
        'Raw bytes come from destination-render response bodies. Candidate and control gzip are recomputed from the exact recorded Drawer chunk identities in their respective builds.',
      totalThroughDrawer: 'initial + incremental Drawer bytes; cumulative total is authoritative.',
      controlDrawerGzipRebuild: controlDrawerGzip,
    },
    metrics: {
      initial: {
        ...initial,
        delta: {
          brotli: delta(initial.control.brotli, initial.candidate.brotli),
          gzip: initialGzipDelta,
          raw: delta(initial.control.raw, initial.candidate.raw),
        },
      },
      incrementalDrawer: {
        ...incrementalDrawer,
        delta: {
          gzip: delta(incrementalDrawer.control.gzip, incrementalDrawer.candidate.gzip),
          raw: delta(incrementalDrawer.control.raw, incrementalDrawer.candidate.raw),
        },
      },
      totalThroughDrawer: {
        ...totalThroughDrawer,
        delta: {
          gzip: totalGzipDelta,
          raw: delta(totalThroughDrawer.control.raw, totalThroughDrawer.candidate.raw),
        },
      },
      drawerOpenMs: {
        control: {
          samples: controlDrawerSamples.map((sample) => sample.drawerOpenMs),
          median: controlDrawerOpenMedian,
        },
        candidate: {
          samples: candidateDrawerSamples.map((sample) => sample.drawerOpenMs),
          median: candidateDrawerOpenMedian,
        },
        delta: drawerOpenDelta,
      },
      duplicatedArkOrZagCount,
    },
    gate: {
      wording: 'total chargé après ouverture du Drawer',
      interpretation:
        'Cumulative totalThroughDrawer is authoritative, not incremental-only. Initial target gzip must decrease by at least 10 KiB and cumulative totalThroughDrawer growth must be <=5%.',
      initialGzipDecreaseAtLeast10KiB: initialGzipDelta.bytes <= -(10 * 1024),
      totalThroughDrawerGzipGrowthAtMost5Percent: totalGzipDelta.percent <= 5,
      drawerOpenRegressionAtMost10Percent: drawerOpenDelta.percent <= 10,
      noDuplicatedArkOrZag: duplicatedArkOrZagCount === 0,
      passes:
        initialGzipDelta.bytes <= -(10 * 1024) &&
        totalGzipDelta.percent <= 5 &&
        drawerOpenDelta.percent <= 10 &&
        duplicatedArkOrZagCount === 0,
    },
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`plan072-ark-split: wrote ${path.relative(ROOT, OUTPUT_PATH)}; gate=${artifact.gate.passes}\n`);
};

main();
