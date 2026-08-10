import path from 'node:path';
import { parseRequiredNonEmptyString } from './validation';
import { portableContainedPath, relativePathWithin, resolveAbsolutePath } from './verified-path';

export const parseSkillFilePath = (value: unknown, skillDirectory: string): string => {
  const relativePath = parseRequiredNonEmptyString(value, 'skill file path');
  if (path.isAbsolute(relativePath)) {
    throw new Error('skill file path must be relative');
  }
  const basePath = resolveAbsolutePath(skillDirectory);
  const resolvedPath = path.resolve(basePath, relativePath);
  const pathFromBase = relativePathWithin(basePath, resolvedPath, false);
  if (pathFromBase === undefined) {
    throw new Error('skill file path must stay inside the selected skill directory');
  }
  return portableContainedPath(pathFromBase);
};
