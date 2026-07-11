import path from 'node:path';
import { parseRequiredNonEmptyString } from './validation';

export const parseSkillFilePath = (value: unknown, skillDirectory: string): string => {
  const relativePath = parseRequiredNonEmptyString(value, 'skill file path');
  if (path.isAbsolute(relativePath)) {
    throw new Error('skill file path must be relative');
  }
  const basePath = path.resolve(skillDirectory);
  const resolvedPath = path.resolve(basePath, relativePath);
  const pathFromBase = path.relative(basePath, resolvedPath);
  if (pathFromBase === '' || pathFromBase.startsWith('..') || path.isAbsolute(pathFromBase)) {
    throw new Error('skill file path must stay inside the selected skill directory');
  }
  return pathFromBase.split(path.sep).join('/');
};
