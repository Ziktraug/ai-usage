import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_NAME = 'ai-usage';

const isAbsoluteOverride = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0 && path.isAbsolute(value);

const packageJsonAt = async (directory: string): Promise<{ name?: string } | null> => {
  try {
    const text = await readFile(path.join(directory, 'package.json'), 'utf8');
    return JSON.parse(text) as { name?: string };
  } catch {
    return null;
  }
};

export const resolveWideEventLogDirectory = async (
  env: NodeJS.ProcessEnv = process.env,
  startDirectory: string = path.dirname(fileURLToPath(import.meta.url)),
): Promise<string | null> => {
  const override = env.AI_USAGE_LOG_DIR;
  if (isAbsoluteOverride(override)) {
    return override;
  }

  let current = path.resolve(startDirectory);
  for (;;) {
    const packageJson = await packageJsonAt(current);
    if (packageJson?.name === WORKSPACE_NAME) {
      return path.join(current, 'logs');
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
};

export const ensureDirectoryAccessible = async (directory: string): Promise<boolean> => {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
};
