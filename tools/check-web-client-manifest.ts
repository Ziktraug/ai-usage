import { readFile } from 'node:fs/promises';

const webClientModuleManifestFormat = 'ai-usage-web-client-modules' as const;
const webClientModuleManifestVersion = 1 as const;
const serverModulePattern = /\.server(?:\.|\/|\?|$)/u;

interface WebClientModuleManifestChunk {
  fileName: string;
  moduleIds: readonly string[];
  modules: readonly string[];
}

interface WebClientModuleManifest {
  chunks: readonly WebClientModuleManifestChunk[];
  format: typeof webClientModuleManifestFormat;
  target: 'client';
  version: typeof webClientModuleManifestVersion;
}

export interface WebClientManifestViolation {
  chunk: string;
  moduleId: string;
  rule: string;
}

interface ForbiddenModuleRule {
  matches: (moduleId: string) => boolean;
  name: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isNonEmptyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every(hasText);

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((value) => rightSet.has(value));
};

const normalizedModuleId = (moduleId: string): string => moduleId.replaceAll('\\', '/').toLowerCase();

const includesPathSegment = (moduleId: string, segment: string): boolean =>
  moduleId === segment ||
  moduleId.startsWith(`${segment}/`) ||
  moduleId.includes(`/${segment}/`) ||
  moduleId.includes(`/node_modules/${segment}/`);

const packageOrWorkspaceRule = (name: string, packageName: string, workspacePath: string): ForbiddenModuleRule => ({
  matches: (moduleId) => {
    const normalized = normalizedModuleId(moduleId);
    return includesPathSegment(normalized, packageName) || normalized.includes(`/${workspacePath}/`);
  },
  name,
});

const forbiddenModuleRules: readonly ForbiddenModuleRule[] = [
  { matches: (moduleId) => normalizedModuleId(moduleId).includes('node:'), name: 'node builtin' },
  { matches: (moduleId) => normalizedModuleId(moduleId).includes('bun:'), name: 'Bun builtin' },
  packageOrWorkspaceRule('@orpc/server', '@orpc/server', 'node_modules/@orpc/server'),
  packageOrWorkspaceRule('usage-store', '@ai-usage/usage-store', 'packages/usage-store'),
  packageOrWorkspaceRule('report-data', '@ai-usage/report-data', 'packages/report-data'),
  packageOrWorkspaceRule('local-machine', '@ai-usage/local-machine', 'packages/local-machine'),
  packageOrWorkspaceRule('usage-merge', '@ai-usage/usage-merge', 'packages/usage-merge'),
  packageOrWorkspaceRule('usage-engine-runtime', '@ai-usage/usage-engine-runtime', 'packages/usage-engine-runtime'),
  {
    matches: (moduleId) => {
      const normalized = normalizedModuleId(moduleId);
      return normalized.includes('$lib/server') || normalized.includes('/src/lib/server/');
    },
    name: '$lib/server',
  },
  {
    matches: (moduleId) => serverModulePattern.test(normalizedModuleId(moduleId)),
    name: '.server module',
  },
  {
    matches: (moduleId) => {
      const normalized = normalizedModuleId(moduleId);
      return (
        includesPathSegment(normalized, 'solid-js') ||
        normalized.includes('@tanstack/solid') ||
        includesPathSegment(normalized, 'vite-solid') ||
        includesPathSegment(normalized, 'vite-plugin-solid') ||
        includesPathSegment(normalized, 'lucide-solid') ||
        includesPathSegment(normalized, '@ark-ui/solid')
      );
    },
    name: 'retired Solid/TanStack module',
  },
  {
    matches: (moduleId) => {
      const normalized = normalizedModuleId(moduleId);
      return (
        includesPathSegment(normalized, 'nitro') ||
        includesPathSegment(normalized, 'nitropack') ||
        normalized.includes('nitro-loopback')
      );
    },
    name: 'retired Nitro module',
  },
  {
    matches: (moduleId) => {
      const normalized = normalizedModuleId(moduleId);
      return normalized.includes('createserverfn') || normalized.includes('_serverfn');
    },
    name: 'retired createServerFn module',
  },
];

export const parseWebClientModuleManifest = (text: string): WebClientModuleManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error('The Web client module manifest is not valid JSON.', { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error('The Web client module manifest must be a JSON object.');
  }
  if (parsed.format !== webClientModuleManifestFormat) {
    throw new Error(`The Web client module manifest format must be ${webClientModuleManifestFormat}.`);
  }
  if (parsed.version !== webClientModuleManifestVersion) {
    throw new Error(`The Web client module manifest version must be ${webClientModuleManifestVersion}.`);
  }
  if (parsed.target !== 'client') {
    throw new Error('The Web client module manifest must describe the client target.');
  }
  if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
    throw new Error('The Web client module manifest must contain at least one chunk.');
  }

  const chunks = parsed.chunks.map((chunk, index) => {
    if (!(isRecord(chunk) && hasText(chunk.fileName))) {
      throw new Error(`Web client module manifest chunk ${index} must have a non-empty fileName.`);
    }
    if (!(isNonEmptyStringArray(chunk.moduleIds) && isNonEmptyStringArray(chunk.modules))) {
      throw new Error(`Web client module manifest chunk ${chunk.fileName} must contain moduleIds and modules.`);
    }
    if (
      new Set(chunk.moduleIds).size !== chunk.moduleIds.length ||
      new Set(chunk.modules).size !== chunk.modules.length
    ) {
      throw new Error(`Web client module manifest chunk ${chunk.fileName} contains duplicate module identifiers.`);
    }
    if (!sameStringSet(chunk.moduleIds, chunk.modules)) {
      throw new Error(`Web client module manifest chunk ${chunk.fileName} has incomplete module metadata.`);
    }
    return {
      fileName: chunk.fileName,
      moduleIds: chunk.moduleIds,
      modules: chunk.modules,
    };
  });

  if (new Set(chunks.map(({ fileName }) => fileName)).size !== chunks.length) {
    throw new Error('The Web client module manifest contains duplicate chunk file names.');
  }
  return {
    chunks,
    format: webClientModuleManifestFormat,
    target: 'client',
    version: webClientModuleManifestVersion,
  };
};

export const scanWebClientModuleManifest = (
  manifest: WebClientModuleManifest,
): readonly WebClientManifestViolation[] => {
  const violations: WebClientManifestViolation[] = [];
  for (const chunk of manifest.chunks) {
    for (const moduleId of chunk.moduleIds) {
      for (const rule of forbiddenModuleRules) {
        if (rule.matches(moduleId)) {
          violations.push({ chunk: chunk.fileName, moduleId, rule: rule.name });
        }
      }
    }
  }
  return violations;
};

export const checkWebClientModuleManifest = async (
  manifestFile: string,
): Promise<readonly WebClientManifestViolation[]> => {
  let text: string;
  try {
    text = await readFile(manifestFile, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read the Web client module manifest at ${manifestFile}.`, { cause: error });
  }
  return scanWebClientModuleManifest(parseWebClientModuleManifest(text));
};

const reportViolations = (violations: readonly WebClientManifestViolation[]): void => {
  if (violations.length === 0) {
    return;
  }
  console.error('The emitted Web client graph contains forbidden modules.');
  for (const violation of violations) {
    console.error(`${violation.chunk} -> ${violation.moduleId} (${violation.rule})`);
  }
  process.exitCode = 1;
};

if (import.meta.main) {
  const manifestFile = process.argv[2];
  if (!manifestFile) {
    throw new Error('Usage: bun tools/check-web-client-manifest.ts <private-client-manifest.json>');
  }
  reportViolations(await checkWebClientModuleManifest(manifestFile));
}
