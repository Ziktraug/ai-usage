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

## Decisions this plan closes

Three questions were left open. Each is closed here, because each blocks the
first line of code and none can be resolved by an executor mid-flight without
guessing on a `Risk: CRITICAL` surface.

### 1. The authentication library — Better Auth

**Decision: Better Auth**, behind application-owned identity services.

| Force | Reading |
|---|---|
| Runtime | TypeScript-native and Bun-compatible. The repo is Bun-only (`package.json:47` `packageManager: bun@1.3.13`). |
| Storage | PostgreSQL via a Drizzle adapter — the ORM plan 101 already introduced. No second migration mechanism. |
| Self-hosting | A library, not a service. This matters: plan 103 already rejected adding a server process for authorization; adding one for authentication would contradict that within the same program. |
| Coverage | GitHub OAuth, sessions, account linking, and passkeys/MFA as plugins — the "future MFA without schema replacement" requirement. |

Rejected alternatives, named:

- **Auth.js/NextAuth** — its adapter model and framework coupling fit Next.js;
  this is SvelteKit on a Bun adapter (ADR 0011).
- **Ory Kratos / Keycloak** — a separate service with its own datastore and
  admin surface. Same objection as OpenFGA in plan 103, and the same answer.
- **Hand-rolled OAuth + sessions** — the plan already forbids it, correctly.

**Verify before writing code, do not assume.** Library ecosystems move, and this
plan was written on 2026-08-26. Step 1 is a 30-minute spike that confirms, against
the *current* release: Bun runtime support, a Drizzle PostgreSQL adapter, GitHub
provider, and account linking with verification. If any is missing or has
regressed, **stop and report** rather than substituting a library silently — the
choice interacts with plan 103's principal model.

### 2. The device credential — bearer token, stored as a server-side verifier

**Decision: a high-entropy random bearer credential, transmitted over HTTPS,
stored server-side only as an Argon2id verifier.** Never a Web session cookie,
never a GitHub token.

Rejected:

- **Asymmetric device key pair** — better non-repudiation, but it buys nothing
  the threat model needs. Traffic is outbound-only over TLS (ADR 0029), and
  replay protection comes from plan 107's idempotency keys, not from the
  credential. The cost is real: key generation, OS-keychain storage of a private
  key, and per-request signing on every device.
- **mTLS** — certificate lifecycle and rotation for a self-hosted single-operator
  product. The plan's own text says "only if operational complexity is
  justified". It is not.

**Reversal condition**: if a later plan needs proof that a specific device
produced a specific payload (non-repudiation, not just authentication), revisit.
Nothing in 105–110 needs that.

### 3. Password authentication — BLOCKED, and that is the deliverable

**Decision: ship GitHub sign-in only. Record password login as BLOCKED.**

This plan's own escape clause applies: "If recovery, email delivery, and abuse
controls cannot be delivered coherently, ship GitHub login first and record
password login as BLOCKED rather than a partial unsafe flow."

They cannot be delivered coherently here, and the reason is specific rather than
squeamish: **password recovery requires transactional email**, which means an
SMTP provider, deliverability handling, bounce processing, and a new class of
secret in the deployment. No other plan in 099–110 needs email. Introducing that
dependency to serve a fallback login — on a product whose users are, by
definition, developers with GitHub accounts — is the largest scope-to-value
mismatch in the program.

What ships instead: the first-owner bootstrap (below) covers the
no-GitHub-available case for self-hosting.

**Revisit when** a user without a usable GitHub account needs access, or an
organization requires non-SCM login. At that point password auth is one Better
Auth plugin plus the email infrastructure — the schema does not change, which is
what makes deferring it cheap.

Record this in `plans/README.md` as **BLOCKED (deliberate)**, not as an
oversight, and mark the sub-section below `## Password authentication` with the
same status so a future executor does not re-litigate it from scratch.

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

## Current state

### The repository already has a redacted-secret pattern — reuse it

`packages/usage-engine-control/src/secret.ts:1-30` holds a branded token type
whose value lives in a `WeakMap`, never on the object:

```ts
const tokenValues = new WeakMap<UsageEngineBearerToken, string>();
declare const usageEngineBearerTokenBrand: unique symbol;

class RedactedUsageEngineBearerToken implements UsageEngineBearerToken {
  constructor(value: string) { tokenValues.set(this, value); Object.freeze(this); }
  toJSON(): string { return '[REDACTED]'; }
  toString(): string { return '[REDACTED]'; }
}
```

`revealUsageEngineBearerToken` (`:46-50`) is the only accessor. The consequence
is that accidental logging, JSON serialization, or template interpolation of a
credential produces `[REDACTED]` **by construction** rather than by review.

Copy this shape for `DeviceCredential`. Do not extend
`UsageEngineBearerToken` itself — the local control-plane token and a device
credential are different objects with different lifetimes, and sharing the brand
would let one be passed where the other is expected.

### Private-file conventions already exist

- `packages/local-collectors/src/private-storage.ts:8,54` — `0o600`, applied
  with an explicit `chmodSync` after write.
- `packages/usage-engine-control/src/handoff.ts:8-12` — `0o700` directories,
  `0o600` files, and `O_CREAT | O_EXCL | O_NOFOLLOW` creation flags. The
  `O_NOFOLLOW` is deliberate: it defeats symlink substitution on the inbox path.

Device-credential storage uses the same flags. There is no reason to invent a
different file discipline in this plan.

### Vocabulary warning: `handoff` is already taken

`packages/usage-engine-control/src/handoff.ts`, `contracts.ts`
(`UsageEngineHandoffId`), `packages/usage-engine-runtime/src/input-file.ts`, and
seven more files use **handoff** to mean *a staged file passed from the CLI to
the usage engine through an inbox directory*. That is file transport, not work
continuity.

Plan 108 introduces **Handoff** meaning cross-harness work continuity. This plan
does not use either sense — but do not name anything here `handoff`, and confirm
plan 100 added the disambiguation to `CONTEXT.md` before plan 108 starts.

### The `authorize` collision, restated

Plan 103's Current state documents it: `SourceAuthority` and `authorizeRows` in
`packages/report-data` mean *filesystem-trust provenance*, not principal
permission. This plan's principals go through `@ai-usage/authorization`.

### Prerequisites

- Plan 102: `people`, `spaces`, `devices`, `space_memberships`.
- Plan 103: the `Authorizer` port, the conformance suite, and the PostgreSQL
  adapter. **Every route this plan adds is authorized through that port** — this
  plan adds no permission logic of its own.

If `packages/authorization/src/conformance.ts` does not exist, stop.

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

## Password authentication — dated resolution: BLOCKED (2026-08-26)

**Not implemented in this plan.** See "Decisions this plan closes" §3: password
recovery requires transactional email, which no other plan in 099–110 needs, and
the users of this product are developers with GitHub accounts. The first-owner
bootstrap (Step 4) covers self-hosting without GitHub.

The requirements below are retained as the specification for whoever unblocks
it, so the work is scoped rather than re-derived. Do not implement a subset:
partial password auth without recovery and abuse controls is the unsafe flow
this section exists to prevent.

Requirements when unblocked:

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

### Credential form — dated resolution (2026-08-26)

A high-entropy random bearer credential over HTTPS, stored server-side only as
an Argon2id verifier. Rationale and the two rejected alternatives are in
"Decisions this plan closes" §2; the implementation is Step 5.

Invariants that survive whatever the form:

- rotation, revocation, and self-hosting are supported;
- replay protection comes from plan 107's idempotency keys, not the credential;
- a Web session cookie or GitHub token is **never** reused as a device credential.

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

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite: authorization exists | `test -f packages/authorization/src/conformance.ts` | exit 0 |
| Library spike (Step 1) | `bun add better-auth --cwd packages/identity && bun test packages/identity/src/library-spike.test.ts` | GitHub provider + Drizzle adapter resolve under Bun |
| Identity tests | `bun test packages/identity` | all pass |
| Enrollment tests | `bun test packages/identity/src/enrollment.test.ts` | all pass |
| Credential redaction proof | `bun test packages/identity/src/credential.test.ts` | all pass |
| Server auth routes | `bun test apps/server/src/auth-routes.test.ts` | all pass |
| Authorization still conformant | `bun test packages/authorization` | 15/15 |
| Secret-leak sweep | `bun tools/check-secret-redaction.ts` | no findings |
| Local regression, no cluster | `! pgrep -x postgres && bun run test:packages` | all pass |
| Boundaries | `bun run lint` | exit 0 |
| Full verification | `bun run check && bun run lint && bun run typecheck && bun run test` | exit 0 |

## Git workflow

- Branch `plan/104-authentication`, cut from plan 103's branch.
- Stage by explicit path. Never `git add -A`.
- Four commits:
  1. `feat(identity): add person, authentication identity, and SCM account separation`
  2. `feat(server): add GitHub sign-in and web sessions`
  3. `feat(identity): add device enrollment with revocable credentials`
  4. `docs(adr): record the authentication library and device credential decisions`
- `bun.lock` changes in commit 1 or 2. Commit it.
- **Do not push or open a PR.** Credential handling — maintainer review before
  anything depends on it.

## Steps

### Step 1: Confirm the library before committing to it

Half a day, and it can save the plan.

1. `packages/identity` scaffolded per plan 101 Step 2 (package.json with
   `exports`, tsconfig, plus registration in
   `tools/check-typescript-coverage.ts:4` and
   `tools/check-package-boundaries.ts:61`).
2. `src/library-spike.test.ts` — a throwaway test proving, against the version
   actually installed:
   - it imports and initializes under Bun (not just Node);
   - the Drizzle PostgreSQL adapter connects to a `startPostgresCluster` URL;
   - its migrations apply, and its tables do **not** collide with
     `platform_migrations` or plan 102's tables;
   - the GitHub provider is configurable with a self-hosted callback URL;
   - account linking exists and can be gated on verification.
3. Record the resolved version in the ADR.

**If any check fails, stop and report.** Do not substitute a library — the
choice interacts with plan 103's principal model, and that is a maintainer
decision.

Delete `library-spike.test.ts` in the same commit that adds the real
integration; a spike test kept around becomes a second source of truth.

**Verify**: spike passes, version recorded.

### Step 2: The identity schema — four objects, deliberately not merged

Migration `0004_identity`:

```text
people                    -- exists from plan 102
authentication_identities (id, person_id NOT NULL, provider, provider_account_id,
                           verified_at, created_at)
                           UNIQUE (provider, provider_account_id)
scm_accounts              -- exists from plan 102; add installation_id NULL,
                           scopes, linked_at, and credential-reference metadata
                           while preserving its Space-scoped uniqueness
devices                   -- exists from plan 102; add:
                           credential_verifier text NULL,
                           credential_created_at timestamptz NULL,
                           status text NOT NULL DEFAULT 'pending',
                           last_seen_at timestamptz NULL,
                           revoked_at timestamptz NULL
device_enrollment_grants  (id, person_id, space_id, proposed_label,
                           token_verifier text NOT NULL, expires_at,
                           consumed_at timestamptz NULL, created_at)
```

The separations that must survive review:

- **`authentication_identities` ≠ `scm_accounts`.** Signing in with GitHub and
  granting repository access are different acts with different revocation. The
  same GitHub account can be both; they are still two rows. `scm_accounts.person_id`
  is nullable because an organization installation may exist before any person
  links it.
- **`device_enrollment_grants.token_verifier`, never the token.** Same for
  `devices.credential_verifier`. A test asserts no column in either table ever
  holds a value that authenticates — see Step 5.
- **`status` on `devices`**, not a computed view over `revoked_at`. The
  `pending → active → revoked` lifecycle has a rotation state that a nullable
  timestamp cannot express.

**Verify**: `bun test packages/postgres-store/src/migrations.test.ts` → the
from-empty, idempotent, ordered, and concurrent cases still pass.

### Step 3: GitHub sign-in and web sessions

1. `packages/identity/src/authentication.ts` — application services wrapping the
   library. The rule from the plan's own text, made mechanical: public domain
   code must not depend on library row types.

   Add a boundary policy so it is checked, not remembered:
   ```ts
   {
     packageName: '@ai-usage/web-contract',
     forbiddenDependencies: ['better-auth'],
     forbiddenImports: ['better-auth'],
     reason: 'public contracts must not expose authentication-library row types.',
   },
   ```
   Same for `@ai-usage/authorization` and `@ai-usage/postgres-store`.

2. Session cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix,
   rotation on privilege change, absolute and idle expiry. `SameSite=Lax` rather
   than `Strict` so that the OAuth callback works; note that reasoning in a
   comment or someone will "harden" it to `Strict` and break sign-in.

3. `auth-routes.test.ts`:
   - sign-in creates exactly one `people` row and one
     `authentication_identities` row;
   - signing in twice does not create a second person;
   - a **different** GitHub account creates a different person, never a link
     (linking is explicit, Step 6);
   - session cookie carries every attribute above;
   - session ID rotates on privilege change;
   - an expired session is rejected as unauthenticated, not as forbidden.

**Verify**: `bun test apps/server/src/auth-routes.test.ts` → all pass.

### Step 4: First-owner bootstrap

The self-hosting path, and the reason password auth can be deferred.

- A server with zero `people` rows accepts the first successful GitHub sign-in
  as the owner of a new personal Space, **only** when an explicit
  `AI_USAGE_PLATFORM_BOOTSTRAP=allow` is set in config
  (`apps/server/src/config.ts`).
- The variable is single-use in effect: once a person exists, bootstrap is
  refused even if it is still set. Assert that — a bootstrap flag left in a
  deployment file is the realistic failure, and it must be inert.
- The bootstrap sign-in is written to `identity_events` with source
  `bootstrap`.

**Verify**: `bootstrap.test.ts` — zero people + flag → owner created; one person
+ flag still set → refused; zero people + no flag → refused with a typed error
naming the variable.

### Step 5: Device enrollment

1. **Grant** — an authenticated person requests one for a chosen Space and
   proposed label. `listResources`/`check` through plan 103's port decides
   whether they may enroll into that Space; this plan adds no permission logic.
   The grant token is returned once, stored as an Argon2id verifier, and expires
   in 15 minutes.

2. **Exchange** — the local CLI posts the token over HTTPS. The server, in one
   transaction:
   - verifies the token against the verifier;
   - checks `consumed_at IS NULL` and `expires_at > now()`;
   - sets `consumed_at` with `UPDATE … WHERE consumed_at IS NULL RETURNING` —
     the atomic single-use consumption, in SQL rather than in application logic;
   - creates the device `active` and issues a credential;
   - returns the credential exactly once.

   `enrollment.test.ts` must include a **concurrent exchange** test: two
   simultaneous requests with the same token, exactly one device created. This
   is the test that proves the `WHERE consumed_at IS NULL` guard, and it is the
   reason to write the update that way.

3. **Local storage** — `packages/local-machine` writes the credential using the
   existing discipline: `0o700` directory, `0o600` file,
   `O_CREAT | O_EXCL | O_NOFOLLOW` (`usage-engine-control/src/handoff.ts:8-12`).
   OS keychain is out of scope for this plan; document the file-based limitation
   in `apps/cli/README.md` rather than half-implementing keychain support.

4. **The credential type** — mirror `secret.ts`:
   ```ts
   declare const deviceCredentialBrand: unique symbol;
   export interface DeviceCredential {
     readonly toJSON: () => string;   // '[REDACTED]'
     readonly toString: () => string; // '[REDACTED]'
     readonly [deviceCredentialBrand]: 'DeviceCredential';
   }
   ```
   `credential.test.ts`: `JSON.stringify({ credential })` contains `[REDACTED]`;
   `` `${credential}` `` contains `[REDACTED]`; the raw value appears in no wide
   event; `revealDeviceCredential` is the only accessor and is not exported from
   the package's public `exports` map.

5. `tools/check-secret-redaction.ts` — greps the source for template
   interpolation and `JSON.stringify` of credential-typed identifiers, and for
   any `console.*` or wide-event call whose arguments include one. Add it to
   `package.json:24`'s `lint` chain. It will produce false positives; make it
   suppressible with an explicit inline comment so suppression is reviewable.

**Verify**: `bun test packages/identity/src/enrollment.test.ts` → all pass,
including concurrent exchange. `bun tools/check-secret-redaction.ts` → no findings.

### Step 6: Lifecycle, linking, and service principals

**Device lifecycle** — list, rename, show last-seen and credential age, rotate,
revoke one, revoke all. Tests:

- a revoked device cannot ingest (assert the typed rejection, and that it is
  distinguishable from an expired credential);
- a revoked device cannot enroll itself again;
- **historical provenance stays readable** — rows published before revocation
  remain visible with their device label. This is the program's gate #4 and the
  one most likely to be broken by a `CASCADE`;
- rotation: the old credential stops working at cutover, the new one works, and
  no window exists where both fail.

**Account linking** — always explicit, always verified, never inferred from a
matching email. `linking.test.ts`: same email on two providers does **not**
auto-link; linking requires an authenticated session on the target person;
unlinking the last authentication identity is refused (it would orphan the
person).

**Service principals** — background jobs get their own principal row and go
through `Authorizer` like everyone else. `service-principal.test.ts` asserts a
job principal is denied a permission it was not granted. The failure mode this
prevents is a job that runs as "the deployment owner" and quietly has every
permission.

**Verify**: `bun test packages/identity` → all pass.

### Step 7: Local-only mode stays untouched

The gate, run with no cluster and no server:

1. `! pgrep -x postgres` → exit 0.
2. `bun run test:packages` → all pass.
3. `bun run dev` → engine + web start; the report renders.
4. `bun run demo` → starts.
5. There is no sign-in wall. Assert it: an e2e spec loads `/` in local mode and
   asserts no authentication redirect occurs.

The local operator is authenticated by `local-authorizer` (plan 103 Step 2),
which allows only the local operator's own personal Space. Nothing in this plan
runs in local mode.

**Verify**: the five checks above, in order.

### Step 8: Documentation and status

- `packages/identity/README.md` — the four identity objects and why they are
  four; the credential lifecycle; what is *not* implemented (password auth,
  keychain) and the trigger for revisiting each.
- ADR 0035 `better-auth-behind-identity-services` — the verified library choice,
  GitHub-first/password-BLOCKED consequence, rejected alternatives, and reversal
  condition.
- ADR 0036 `bearer-device-credentials` — the verifier-only bearer design,
  rejected asymmetric/mTLS alternatives, threat model, and reversal condition.
- `CONTEXT.md` — plan 100 added **Person**, **Authentication identity**, **SCM
  account**, **Device**. Verify they match what shipped; amend rather than
  diverge.
- `docs/architecture.md` — extend the `apps/server` block with the auth surface;
  add a `### Credential handling` subsection under Guardrails (`:467`) naming
  the redaction pattern and the `0o600`/`O_NOFOLLOW` file discipline.
- `plans/README.md:66` — this plan's row `DONE`, with
  `password login BLOCKED (deliberate — see plan 104 Decisions)` in the status
  cell so it is visible from the index.

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
