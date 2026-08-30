# Authentication and Device enrollment

This living reference defines the connected authentication, Web-session, and
Device-enrollment slice. Authentication establishes a Person principal;
`Authorizer` still decides every resource operation. Local-only Usage, Skills,
Memory, Project review, CLI reads, and Web builds remain available with no
login or shared-server call.

## Supported boundary

Connected V1 supports normal sign-in through GitHub only. A deployment needs a
GitHub OAuth application and a usable callback origin. Password, passkey,
email-link, SAML/SCIM, mandatory MFA, and a custom bootstrap session are not
part of V1. Connected self-hosting without GitHub authentication is therefore
unsupported; local-only mode is the supported no-account composition. Future
human passwords require an accepted recovery/email/abuse design and Argon2id;
that password-hash rule does not apply to random Device tokens.

The implementation pins Better Auth and its Drizzle adapter to `1.7.2`. The
compatibility spike used Bun `1.3.13`, SvelteKit's standard Request boundary,
PostgreSQL/Drizzle, GitHub OAuth with PKCE, secure cookies, database state, and
explicit linking. `@ai-usage/identity` hides library row/API types; only
`apps/server` composes shared authentication, and only the PostgreSQL adapter
imports the Better Auth Drizzle adapter.

## Identity and GitHub separation

The stable GitHub subject identifies an Authentication identity. Username,
email, and avatar are mutable profile data and never Person identity. Login
requests exactly `read:user user:email`; repository scopes and installation
grants are absent. GitHub App/repository connection remains a separate future
action over the existing Person-scoped `ScmAccount`, Space-scoped
`ScmInstallation`, and exclusively owned `ScmCredential` tables.

Implicit account linking is disabled. Better Auth stores a subject-derived,
non-routable internal email, so equal provider emails or handles cannot merge
People. An authenticated fresh GitHub OAuth flow may explicitly link another
identity to the same Person. The link is audited, invalidates all existing Web
sessions, and requires a new login whose session records the exact identity
just proved. Unlink is audited, preserves the historical Authentication
identity as revoked, and refuses the last active GitHub identity.

First-owner bootstrap runs only after successful GitHub OAuth, only when the
typed deployment policy is enabled, and only while zero People and no permanent
bootstrap marker exist. A PostgreSQL transaction and advisory lock create the
Person, personal Space, identity, marker, and audit event at most once.
Leaving the flag enabled after success has no effect. It is not a credential
and cannot bootstrap a user without GitHub.

## Web sessions

The HTTPS cookie is host-only, `HttpOnly`, `Secure`, `SameSite=Lax`, and uses a
`__Host-ai-usage-*` name. Development HTTP uses an explicitly separate cookie
prefix. PostgreSQL stores only a SHA-256/base64url token digest; raw session
tokens, raw IP history, and user-agent dumps are not retained. Provider access
and refresh tokens are encrypted by Better Auth and never returned by the
domain session API.

Sessions are non-sliding with a 24-hour absolute/idle limit and 15-minute fresh
window. Each login creates a new session. Linking forces reauthentication;
unlinking an identity invalidates a session bound to it. `POST
/api/session/revoke-all` and Better Auth sign-out remove sessions. Every
cookie-authenticated application mutation also requires the configured exact
Origin; OAuth state, PKCE, CSRF, and origin checks remain enabled.

The application exposes only a narrow domain projection at `GET /api/session`.
Better Auth account/session listing and raw `get-session` routes are disabled.
Every authenticated session resolves through an active Authentication identity
to an active Person and then calls `Authorizer` for the requested resource.

## Device and enrollment tokens

An enrollment grant or Device credential is:

```text
public_token_id.random_secret
```

The public ID is 16 random bytes (22 base64url characters); the secret is 32
random bytes (43 characters). PostgreSQL stores the public ID, key version, and
43-character HMAC-SHA-256 digest. The deployment key is 32–128 bytes, supplied
outside PostgreSQL. Lookup is indexed by public ID and digest comparison is
constant-time. The redacted token object serializes and interpolates only as
`[REDACTED]`; one narrow transport/storage accessor can reveal plaintext.

An authenticated Person requests a 15-minute grant for an explicit Space and
label. `Authorizer.manage_device` is checked before creation and again inside
the PostgreSQL mutation. Exchange verifies/consumes the grant and creates the
Device plus a distinct credential in one transaction; concurrent exchanges
produce exactly one Device. Authentication updates last-seen metadata only
after verifier and lifecycle checks. List, rename, rotate, revoke-one, and
revoke-all remain authorization-scoped. Rotation revokes the old credential
and inserts the new one atomically. Revocation happens before any future ingest
authorization, while historical Device rows remain readable.

### Key rotation

`AI_USAGE_DEVICE_TOKEN_KEYS` is an ordered comma-separated key ring:
`currentVersion:base64urlKey,oldVersion:base64urlKey`. The first entry creates
new verifiers; retained versions verify existing ones. To rotate:

1. deploy the new key first while retaining every referenced old version;
2. rotate active Device credentials; allow all old 15-minute grants to expire;
3. verify no active credential or unexpired grant references the old version;
4. remove that version and retain the server's coarse
   `device-token-key-version-active` startup diagnostics as the deployment
   audit record.

`AI_USAGE_AUTH_SECRETS` uses the same ordered versioned syntax. Retain old auth
secrets for at least the maximum 24-hour session/OAuth-state lifetime before
removal. Never put either key ring in PostgreSQL, logs, URLs, issue text, or a
checked-in environment file.

TLS, entropy, key generations, explicit revocation, publication generations,
logical batch identity, and idempotency jointly constrain replay. The
replication endpoint rechecks the credential and Device in the same PostgreSQL
transaction that applies immutable receipts, fact-key projections, generation,
and the stored ACK; see [Device replication](device-replication.md).
A copied live credential remains usable until rotation/revocation, so
idempotency is not a complete stolen-token defense.

## Private local storage

`@ai-usage/identity/private-device-credential` is the V1 fallback when no
complete OS-keychain adapter exists. It creates/requires an owner-only `0700`
directory and an owner-only, single-link `0600` regular file. Writes use a
unique exclusive/no-follow temporary file, `fsync`, atomic rename, and inode
revalidation. Reads use `O_NOFOLLOW`, a fixed byte bound, strict UTF-8/JSON,
exact schema validation, and before/after/current inode fingerprints.

The file contains the recoverable plaintext because a Device must present it;
filesystem permissions are not encryption. The adapter does not protect
against root, the same operating-system user, compromised backups, or malware
in that account. Do not sync the file, expose it in diagnostics, or copy it as
a general machine identity. Rotate/revoke after suspected disclosure. An OS
keychain may replace this adapter later without changing the domain token.

## HTTP surface and audit

Application-owned routes are bounded, `no-store`, and return fixed error codes:

| Route | Authentication and purpose |
| --- | --- |
| `/api/auth/sign-in/social`, `/callback/github` | GitHub OAuth only |
| `/api/auth/link-social`, `/unlink-account` | Explicit Authentication identity lifecycle |
| `/api/auth/sign-out`, `/revoke-sessions` | Better Auth session lifecycle |
| `GET /api/session`, `POST /api/session/revoke-all` | Domain session projection/lifecycle |
| `POST /api/device-enrollment-grants` | Cookie + Origin + Authorizer |
| `POST /api/device-enrollment-exchanges` | One-time grant bearer |
| `POST /api/device-credentials/verify` | Device bearer; explicit shared publication identity |
| `POST /api/replication/batches` | Device bearer; bounded idempotent fact publication |
| `GET/DELETE /api/devices` | Authorized list/revoke-all |
| `PATCH/DELETE /api/devices/:id` | Authorized rename/revoke |
| `POST /api/devices/:id/credential-rotation` | Authorized atomic cutover |

Identity audit rows contain stable UUIDs, bounded event classes, timestamps,
and empty bounded details. They cover bootstrap, link/unlink, successful login,
session revocation, grant creation/exchange, Device rotation, and revocation.
OAuth codes, provider/session/Device tokens, password fragments, IP history,
user-agent dumps, labels, and content are absent.

Plan 104 starts no background job. Merely running inside `apps/server` grants
no resource access: service principals remain explicit `Authorizer` inputs and
are denied unless a later job documents and tests its narrow permissions.

## Verification

The focused gates are:

```sh
bun test packages/identity
bun run test:local-platform
nix develop --command bun run test:postgres
```

The local gate removes every shared configuration value, injects failing
PostgreSQL and shared-authentication factories, executes representative local
package/engine/CLI/demo/Web flows, and requires zero calls to both factories.
PostgreSQL tests exercise real migrations, OAuth callbacks, digest-only
sessions, explicit/same-email linking cases, concurrent bootstrap, CSRF,
one-time exchange, atomic rotation, revocation, audit rows, and secret-free
HTTP projections.
