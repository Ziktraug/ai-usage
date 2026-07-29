import type { ConfigEnv } from 'vite';

export interface ViteRuntimePaths {
  nitroBuildDirectory: string;
  nitroOutputDirectory: string;
  viteCacheDirectory: string;
}

export const resolveViteRuntimePaths = ({
  command,
  isPreview,
}: Pick<ConfigEnv, 'command' | 'isPreview'>): ViteRuntimePaths => {
  const outputContainer = command === 'build' || isPreview ? '.output-build' : '.output-dev';
  return {
    nitroBuildDirectory: `${outputContainer}/work`,
    nitroOutputDirectory: `${outputContainer}/nitro`,
    viteCacheDirectory: `${outputContainer}/vite`,
  };
};
