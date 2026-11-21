export type StoredUsageRowStatus = 'active' | 'superseded' | 'deleted';
export type StoredSourceAuthority = 'local-observed' | 'portable-opaque';

export interface StoredRowRecord {
  row_json: string;
  row_key: string;
  source_authority: StoredSourceAuthority;
}
