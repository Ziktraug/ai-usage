export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

export const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export const hasCurrentOwner = (uid: number): boolean =>
  typeof process.getuid !== 'function' || uid === process.getuid();

export const isOwnerOnly = (mode: number): boolean => process.platform === 'win32' || mode % 0o100 === 0;
