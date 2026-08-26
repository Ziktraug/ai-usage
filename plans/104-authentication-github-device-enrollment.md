# Plan 104: Add Authentication, GitHub Identity Separation, and Device Enrollment

> **Executor instructions**: Execute only after the Person/Space/Device model and
> Authorizer port are accepted. Authentication establishes principals; it does
> not decide resource access by itself. Keep local-only mode available without a
> login. Do not reuse provider access tokens as long-lived device or Web session
> credentials.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- apps/server apps/web apps/cli apps/usage-engine packages/platform-core packages/postgres-store packages/identity packages/authorization packages/web-contract docs/architecture.md docs/adr`
> Re-read plans 102–103 and reconcile identity or permission changes before
> implementation.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: CRITICAL — credential, account-linking, and session defects can lead
  to account takeover or cross-tenant access
- **Depends on**: 102, 103
- **Category**: authentication, account linking, device trust
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO

## Why this matters

The platform will have at least four identities that are easy to conflate:

1. **Person** — the human represented in ai-usage;
2. **Authentication identity** — GitHub login, password, passkey, or another
   method used to prove that Person;
3. **SCM account/installation** — credentials and repository grants used to
   resolve GitHub/GitLab metadata;
4. **Device credential** — a revocable machine identity used to publish data.

A developer may sign into ai-usage with a personal GitHub identity while also
connecting a professional GitHub organization installation. Another user may
use a password but connect two GitHub accounts. A machine may publish both
personal and organization work. The schema and flows must preserve those
separations.

## Authentication architecture

Use a mature authentication/session implementation rather than building OAuth,
password reset, CSRF protection, and session rotation from primitives. The
executor must evaluate a library/provider compatible with:

- Bun/server runtime;
- self-hosted deployment;
- PostgreSQL-backed sessions/accounts;
- GitHub OAuth/OIDC or GitHub App sign-in;
- optional password credentials;
- account linking with explicit verification;
- secure cookie sessions;
- future passkeys/MFA without schema replacement.

The selected implementation stays behind application-owned identity services.
Public domain code must not depend directly on library-specific account/session
row types.

## Identity tables and concepts

Plan 102 created or proposed Person, SCM Account, and Device. Add authentication
records without merging them.

```text
auth_identities
  id
  person_id
  provider              # github-login, password, passkey, etc.
  provider_subject       # stable provider ID, never display handle as key
  verified_at
  status

web_sessions
  id/hash
  person_id
  created_at
  last_seen_at
  expires_at
  revoked_at
  assurance_level

password_credentials    # optional
  auth_identity_id
  password_hash
  hash_parameters/version
  changed_at

scm_connections
  id
  scm_account_id
  person_id or organization context
  provider
  installation/account identity
  encrypted token reference / refresh metadata
  repository-selection metadata

device_credentials
  id
  device_id
  verifier/hash or public-key material
  created_at
  last_used_at
  expires_at/rotated_at/revoked_at
```

Never store a plaintext password or reusable device token. Passwords are hashed
with Argon2id (or a comparably reviewed current algorithm), not reversibly
encrypted. OAuth/installation secrets that must be recovered are encrypted at
rest through a documented key-management boundary.

## GitHub sign-in versus repository access

These are separate user actions and permissions.

### Sign in with GitHub

Purpose:

- prove a provider subject;
- create or link an Authentication Identity to one Person;
- obtain only scopes required for login identity.

Do not treat the GitHub username as stable. Store the stable provider user ID and
retain the current handle as display metadata.

### Connect GitHub repositories

Purpose:

- install/authorize a GitHub App or equivalent connection;
- select explicit repositories/organizations;
- resolve stable provider repository IDs and rename events;
- optionally enrich PR/repository metadata.

Rules:

- login does not automatically authorize repository access;
- repository installation does not automatically grant ai-usage login to every
  GitHub organization member;
- repository selection is explicit and revocable;
- organization-managed connections belong to organization policy, not a
  developer’s personal login token;
- SCM tokens are never sent to the local collector unless a separate feature
  requires and authorizes it.

## First-owner bootstrap

A new shared deployment needs a safe bootstrap:

1. deployment starts with no People/Spaces;
2. one time-limited or operator-generated bootstrap mechanism creates the first
   Person and personal Space;
3. the first organization owner assignment is explicit;
4. bootstrap credential is invalidated after success;
5. concurrent attempts cannot create multiple first owners;
6. public signup behavior is a separate configuration choice.

Do not use “first request wins” without an unguessable, time-bounded bootstrap
secret and transaction lock.

## Web sessions

Required security properties:

- `HttpOnly`, `Secure` in HTTPS deployments, appropriate `SameSite` cookies;
- session IDs/tokens stored as verifiers/hashes where practical;
- rotation after login, account linking, password change, and assurance upgrade;
- bounded idle and absolute expiry;
- explicit logout and revoke-all-sessions;
- CSRF protection for state-changing cookie-authenticated requests;
- OAuth state/PKCE/nonce verification as applicable;
- no authentication secret in URL logs, browser local storage, or SSR payload;
- session lookup produces a Person principal that still passes Authorizer checks.

The Web app should have one authentication state owner compatible with its
current SvelteKit/oRPC/TanStack Query boundaries. Browser code must not receive
provider access tokens.

## Password authentication (optional first release)

The user requested a conventional fallback in addition to GitHub SSO. It may be
implemented in this plan if the selected auth library supports it safely.

Requirements:

- Argon2id with parameters recorded per hash and upgrade-on-login;
- breached/common-password checks where available without leaking the password;
- rate limiting and progressive abuse controls;
- verified email or equivalent recovery identity before reset;
- single-use, expiring reset tokens stored as hashes;
- generic login/reset responses that avoid account enumeration;
- password changes revoke or rotate relevant sessions;
- no custom crypto.

If recovery, email delivery, and abuse controls cannot be delivered coherently,
ship GitHub login first and record password login as BLOCKED rather than a partial
unsafe flow.

## Account linking

A Person may link more than one Authentication Identity and SCM Account.

Required rules:

- linking requires a currently authenticated session plus fresh proof of the new
  identity;
- provider email equality alone never merges people;
- conflicting existing links require explicit recovery/admin review;
- unlinking cannot remove the last viable authentication method without a
  replacement/recovery step;
- every link/unlink is audited;
- SCM account linking remains distinct from login identity linking.

Tests must cover personal and professional GitHub identities on the same Person.

## Device enrollment

### Flow

1. authenticated Person requests an enrollment grant for a chosen Space and
   proposed Device label;
2. server creates a single-use, short-lived enrollment token with explicit
   allowed context;
3. local CLI/usage-engine exchanges it over HTTPS;
4. server creates/activates the Device and issues an independent device
   credential;
5. local runtime stores the credential in the OS keychain when available or a
   private owner-only file with documented limitations;
6. enrollment token is atomically consumed;
7. future publication authenticates as the Device principal and includes a
   Capture Context that plan 103 authorizes.

### Credential form

The executor should compare:

- high-entropy bearer credential stored only as a verifier server-side;
- asymmetric device key pair with server-stored public key;
- mutually authenticated TLS only if operational complexity is justified.

Prefer the simplest design that supports rotation, revocation, replay
protection/idempotency, and self-hosting. Do not reuse a Web session cookie or
GitHub token.

### Device lifecycle

Support:

```text
pending → active → revoked
                 ↘ rotating credential
```

Required operations:

- list own authorized Devices;
- rename display label;
- show last-seen and credential age without exposing secrets;
- rotate credential with overlap rules or atomic cutover;
- revoke one Device;
- revoke all Devices after compromise;
- historical provenance remains after revocation;
- revoked Device cannot ingest or create a new enrollment for itself.

## Service principals and background jobs

Server jobs use explicit service principals with narrow permissions. They do not
impersonate the deployment owner or bypass Authorizer because they run inside the
server process.

Examples:

- replication projector;
- memory indexer;
- aggregate builder;
- credential cleanup.

Every job’s permission/resource scope must be documented and testable.

## Local-only mode

Local ai-usage remains usable without authentication:

- local Web/CLI identify the local operator through the existing local trust
  boundary;
- local capability services use `SingleUserAuthorizer`;
- no login screen blocks local report/Skills/source workflows;
- connected-only navigation is absent or clearly optional;
- adding connected mode does not expose the local loopback control credential to
  the shared server.

Define how local and connected Web modes select their principal/adapters without
allowing an attacker-controlled request header to switch modes.

## Auditing and privacy

Audit at least:

- successful/failed login classes (without credentials);
- account linking/unlinking;
- password/recovery changes;
- session revoke-all;
- SCM connection installation/removal;
- Device enrollment, rotation, and revocation;
- first-owner bootstrap.

Store stable IDs and coarse failure codes, not OAuth codes, access tokens,
password fragments, full IP histories, or user-agent dumps without a retention
policy.

## Testing requirements

### Authentication tests

- GitHub subject creates/links the correct Person;
- handle/email changes do not create a new Person;
- OAuth state/PKCE/nonce failures are rejected;
- session fixation is prevented through rotation;
- expiry, logout, revoke-all, and password change behavior;
- CSRF rejection on protected mutations;
- no provider token reaches browser payload/logs.

### Account-link tests

- personal and professional GitHub identities link to one Person explicitly;
- email equality does not auto-link;
- identity already linked elsewhere fails safely;
- last auth method cannot be removed unsafely;
- SCM connection remains distinct from login.

### Device tests

- single-use enrollment under concurrency;
- expired enrollment rejected;
- enrollment Space/Person permissions checked through Authorizer;
- device credential stored/verified as designed;
- rotation and revocation;
- revoked Device ingestion rejected;
- historical rows retain Device provenance;
- one Device can publish separate personal and organization Capture Contexts
  without credential duplication.

### Local mode tests

- current local startup has no auth dependency;
- connected-only endpoints cannot be reached through local trust assumptions;
- server authentication configuration is absent from local SSR/client bundles.

## Done criteria

- [ ] Person, Authentication Identity, SCM Account/Connection, Web Session, and
      Device Credential are separate schema/domain concepts.
- [ ] A mature auth implementation is selected through an ADR/threat-model
      review.
- [ ] GitHub login and GitHub repository installation have separate flows and
      scopes.
- [ ] First-owner bootstrap is single-use and concurrency-safe.
- [ ] Web sessions have rotation, expiry, CSRF, revoke, and secret-boundary
      tests.
- [ ] Password fallback is complete and Argon2id-based, or explicitly BLOCKED
      rather than partially shipped.
- [ ] Device enrollment, private storage, rotation, and revocation are tested.
- [ ] Every authenticated request becomes a Person or Device principal and still
      passes the Authorizer.
- [ ] Local-only mode requires no login and does not inherit shared-server
      credentials.
- [ ] Authentication/account/device changes are auditable without secret leakage.

## STOP conditions

Stop and report when:

- the selected auth library cannot run safely in the chosen server runtime;
- GitHub login requires broad repository scopes;
- a provider email or username is proposed as the Person primary key;
- Web sessions or device credentials must be stored plaintext server-side;
- device enrollment can assign an organization Space without an Authorizer
  check;
- a password flow is proposed without reset, rate limiting, and non-enumerating
  behavior;
- provider access tokens would reach browser code or local usage collectors;
- local mode would require a remote session;
- account linking can silently merge two existing People;
- service jobs are implemented as unbounded authorization bypasses.

## Out of scope

- SCIM/directory synchronization;
- SAML enterprise federation;
- mandatory MFA/passkeys in the first connected release;
- billing entitlements;
- remote shell/device control;
- automatic enrollment through LAN discovery;
- repository webhook processing beyond what identity resolution minimally needs.
