import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

export const webClientModuleManifestFormat = 'ai-usage-web-client-modules' as const;
export const webClientModuleManifestVersion = 1 as const;

export interface WebClientModuleManifestChunk {
  dynamicImports: readonly string[];
  fileName: string;
  imports: readonly string[];
  moduleIds: readonly string[];
  modules: readonly string[];
}

export interface WebClientModuleManifest {
  chunks: readonly WebClientModuleManifestChunk[];
  format: typeof webClientModuleManifestFormat;
  target: 'client';
  version: typeof webClientModuleManifestVersion;
}

interface ClientOutputChunk {
  dynamicImports: readonly string[];
  fileName: string;
  imports: readonly string[];
  moduleIds: readonly string[];
  modules: Readonly<Record<string, unknown>>;
  type: 'chunk';
}

type ClientOutputBundle = Readonly<Record<string, ClientOutputChunk | { type: 'asset' }>>;

export interface WebClientModuleManifestPluginOptions {
  manifestFile: string;
  root?: string;
}

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const normalizeSeparators = (value: string): string => value.replaceAll('\\', '/');

const normalizeModuleId = (moduleId: string, root: string): string => {
  if (!path.isAbsolute(moduleId)) {
    return normalizeSeparators(moduleId);
  }
  const relativeId = normalizeSeparators(path.relative(root, moduleId));
  return relativeId.startsWith('.') ? relativeId : `./${relativeId}`;
};

const sortedModuleIds = (moduleIds: Iterable<string>, root: string): readonly string[] =>
  [...new Set([...moduleIds].map((moduleId) => normalizeModuleId(moduleId, root)))].sort(compareText);

export const createWebClientModuleManifest = (bundle: ClientOutputBundle, root: string): WebClientModuleManifest => ({
  chunks: Object.values(bundle)
    .filter((output): output is ClientOutputChunk => output.type === 'chunk')
    .map((chunk) => ({
      dynamicImports: sortedModuleIds(chunk.dynamicImports, root),
      fileName: normalizeSeparators(chunk.fileName),
      imports: sortedModuleIds(chunk.imports, root),
      moduleIds: sortedModuleIds(chunk.moduleIds, root),
      modules: sortedModuleIds(Object.keys(chunk.modules), root),
    }))
    .sort((left, right) => compareText(left.fileName, right.fileName)),
  format: webClientModuleManifestFormat,
  target: 'client',
  version: webClientModuleManifestVersion,
});

export const writeWebClientModuleManifest = async (
  bundle: ClientOutputBundle,
  root: string,
  manifestFile: string,
): Promise<void> => {
  const manifest = createWebClientModuleManifest(bundle, root);
  await mkdir(path.dirname(manifestFile), { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};

export const webClientModuleManifest = ({ manifestFile, root }: WebClientModuleManifestPluginOptions): Plugin => {
  let projectRoot = root ?? '';
  return {
    apply: (_config, environment) => environment.command === 'build' && !environment.isSsrBuild,
    configResolved: (config) => {
      projectRoot = config.root;
    },
    name: 'ai-usage-web-client-module-manifest',
    writeBundle: async (_outputOptions, bundle) => {
      if (!projectRoot) {
        throw new Error('The Web client manifest plugin did not receive a resolved Vite project root.');
      }
      const resolvedManifestFile = path.resolve(projectRoot, manifestFile);
      await writeWebClientModuleManifest(bundle, projectRoot, resolvedManifestFile);
    },
  };
};
