import type { FileHandle } from 'node:fs/promises';

export const readOpenedFileBounded = async (file: Pick<FileHandle, 'read'>, expectedBytes: number): Promise<Buffer> => {
  if (!(Number.isSafeInteger(expectedBytes) && expectedBytes >= 0)) {
    throw new Error('Opened-file expected byte count is invalid.');
  }
  const capacity = expectedBytes + 1;
  const bytes = Buffer.alloc(capacity);
  let totalBytes = 0;
  while (totalBytes < capacity) {
    const { bytesRead } = await file.read(bytes, totalBytes, capacity - totalBytes, totalBytes);
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
  }
  return bytes.subarray(0, totalBytes);
};
