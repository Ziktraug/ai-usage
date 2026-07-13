export const MAX_PORTABLE_USAGE_ROWS = 50_000;
export const MAX_PORTABLE_USAGE_BYTES = 64 * 1024 * 1024;

export const assertPortableUsageByteLength = (
  text: string,
  label: string,
  maxBytes = MAX_PORTABLE_USAGE_BYTES,
): number => {
  const actualBytes = new TextEncoder().encode(text).byteLength;
  if (actualBytes > maxBytes) {
    throw new Error(`${label} contains ${actualBytes} bytes; maximum is ${maxBytes}`);
  }
  return actualBytes;
};

export const assertPortableUsageRowCount = (
  rows: readonly unknown[],
  label: string,
  maxRows = MAX_PORTABLE_USAGE_ROWS,
): void => {
  if (rows.length > maxRows) {
    throw new Error(`${label} contains ${rows.length} rows; maximum is ${maxRows}`);
  }
};
