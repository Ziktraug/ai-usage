# ADR 0035: Opt-in normalized session archives with envelope encryption

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

Cross-machine read-only continuity may need more detail than replicated usage
metadata and reviewed Work handoffs. Native histories can contain prompts,
code, paths, tool output, credentials, and provider state; uploading raw harness
files would create a backup/synchronization product with unsafe authority and
deletion claims.

## Decision

Session detail archiving is opt-in and stores only a bounded,
runtime-validated normalized contract produced on the source Device. Metadata
and detail policy are separate; prompts default to excluded and raw native
files, tool output, source bytes, credentials, attachments, and arbitrary blobs
are never archive payloads.

Normalized content records `archived-observed` authority, parser/archive
version, capture time, completeness, truncation/redaction, provenance,
sensitivity, and limitations. It remains read-only and never authorizes local
filesystem access or native session mutation on another Device.

Classified content is envelope-encrypted with a versioned per-Space DEK wrapped
by a versioned deployment KEK supplied outside PostgreSQL. PostgreSQL may store
wrapped DEKs, ciphertext, and separate listing/authorization metadata. The
server can decrypt authorized content, so this is not end-to-end encryption.
A database backup is recoverable only with the matching KEK; losing it loses
the archive. Deleting current keys does not guarantee erasure from historical
backups, whose retention and key lifecycle must be documented honestly.

## Consequences

- Metadata-only replication remains the default and content requires a separate
  policy and permission.
- Backup/restore, wrong-key failure, KEK rewrap, DEK rotation, purge, and
  authorization-before-decrypt become release gates.
- WorkHandoff readers see only separately reviewed statements unless granted
  archive-content permission.

## Rejected alternative

Uploading raw harness stores was rejected because it would persist unrelated
secrets and undocumented formats while implying restore and native portability
guarantees the product does not provide.

## Reversal condition

Broaden archive content only after a separately accepted threat model,
minimization policy, runtime contract, authorization class, retention/deletion
propagation, backup/key procedure, and synthetic security tests prove the new
data class.

## Evidence

- [Platform data ownership](../architecture.md#platform-data-ownership)
- [Plan 109](../../plans/109-session-detail-archive.md)
