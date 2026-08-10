import { realpath } from 'node:fs/promises';
import path from 'node:path';

declare const absolutePathBrand: unique symbol;
declare const canonicalPathBrand: unique symbol;
declare const containedRelativePathBrand: unique symbol;

export type AbsolutePath = string & { readonly [absolutePathBrand]: 'AbsolutePath' };
export type CanonicalPath = AbsolutePath & { readonly [canonicalPathBrand]: 'CanonicalPath' };
export type ContainedRelativePath = string & {
  readonly [containedRelativePathBrand]: 'ContainedRelativePath';
};

export const resolveAbsolutePath = (...segments: readonly string[]): AbsolutePath =>
  path.resolve(...segments) as AbsolutePath;

export const resolveCanonicalPath = async (value: string): Promise<CanonicalPath> =>
  (await realpath(value)) as CanonicalPath;

export const relativePathWithin = (
  parentPath: string,
  candidatePath: string,
  allowSamePath = true,
): ContainedRelativePath | undefined => {
  const relativePath = path.relative(parentPath, candidatePath);
  if (relativePath === '') {
    return allowSamePath ? (relativePath as ContainedRelativePath) : undefined;
  }
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return;
  }
  return relativePath as ContainedRelativePath;
};

export const isPathWithin = (parentPath: string, candidatePath: string, allowSamePath = true): boolean =>
  relativePathWithin(parentPath, candidatePath, allowSamePath) !== undefined;

export const portableContainedPath = (value: ContainedRelativePath): string => value.split(path.sep).join('/');
