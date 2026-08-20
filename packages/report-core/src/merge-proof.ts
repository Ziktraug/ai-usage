declare const mergeDocumentDigestBrand: unique symbol;
declare const mergeConfirmationTokenBrand: unique symbol;

export type MergeDocumentDigest = string & {
  readonly [mergeDocumentDigestBrand]: 'MergeDocumentDigest';
};

export type MergeConfirmationToken = string & {
  readonly [mergeConfirmationTokenBrand]: 'MergeConfirmationToken';
};

export interface MergePreviewProof {
  readonly confirmationToken: MergeConfirmationToken;
  readonly documentDigest: MergeDocumentDigest;
}

const MERGE_DOCUMENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MERGE_CONFIRMATION_TOKEN_PATTERN = /^v1\.[0-9a-f]{64}$/;

export const isMergeDocumentDigest = (value: unknown): value is MergeDocumentDigest =>
  typeof value === 'string' && MERGE_DOCUMENT_DIGEST_PATTERN.test(value);

export const isMergeConfirmationToken = (value: unknown): value is MergeConfirmationToken =>
  typeof value === 'string' && MERGE_CONFIRMATION_TOKEN_PATTERN.test(value);

export const parseMergeDocumentDigest = (value: unknown): MergeDocumentDigest => {
  if (!isMergeDocumentDigest(value)) {
    throw new Error('Merge document digest must be a lowercase SHA-256 digest');
  }
  return value;
};

export const parseMergeConfirmationToken = (value: unknown): MergeConfirmationToken => {
  if (!isMergeConfirmationToken(value)) {
    throw new Error('Merge confirmation token must be a supported canonical token');
  }
  return value;
};

export const parseMergePreviewProof = (value: unknown): MergePreviewProof => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Merge preview proof must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.hasOwn(record, 'confirmationToken') || !Object.hasOwn(record, 'documentDigest')) {
    throw new Error('Merge preview proof contains unknown or missing fields');
  }
  return Object.freeze({
    confirmationToken: parseMergeConfirmationToken(record.confirmationToken),
    documentDigest: parseMergeDocumentDigest(record.documentDigest),
  });
};
