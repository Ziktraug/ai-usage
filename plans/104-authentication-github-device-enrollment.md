# Plan 104: Add Authentication, GitHub Identity Separation, and Device Enrollment

> **Executor instructions**: Execute after the identity kernel and full shared
> Authorizer are accepted. Authentication establishes a principal; it does not
> grant resource access. Keep local-only mode login-free. Do not reuse GitHub
> tokens or Web sessions as Device credentials.
>
> **Drift check (run first)**:
> `git diff --stat dac2214c..HEAD -- apps/server apps/web apps/cli apps/usage-engine packages/platform-core packages/postgres-store packages/identity packages/authorization packages/web-contract docs/architecture.md docs/adr`

## Authoritative decisions

The contracts and steps below are the current implementation specification.
Superseded alternatives remain in Git history and are not executable guidance.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: CRITICAL — credential, linking, bootstrap, and session defects can
  lead to account takeover or cross-Space access
- **Depends on**: 102, 103
- **Category**: shared authentication, SCM connections, Device trust
- **Planned at**: commit `dac2214c`, 2026-08-26
- **Implementation status**: TODO; non-GitHub login BLOCKED in V1

## V1 decisions

### Shared login

GitHub sign-in is the only normal shared-server login in V1. Use Better Auth
behind application-owned identity services, subject to an implementation spike
against the current release proving Bun/SvelteKit operation, PostgreSQL/Drizzle
adapter behavior, GitHub OAuth, secure sessions, and explicit account linking.
If that spike fails, stop and return to the maintainer; do not silently choose a
different auth stack.

First-owner bootstrap authorizes the first **successful GitHub identity** under
an explicit deployment bootstrap policy and transaction lock. It does not
authenticate a user who cannot use GitHub.

Password, passkey, email-link, and other non-SCM login are explicitly
unsupported/BLOCKED in V1. Self-hosted connected mode without usable GitHub
authentication is unsupported. Do not build a partial password or custom
bootstrap-session system in this plan. Argon2id is reserved for future human
passwords if a complete recovery/email/abuse-control design is approved.

Local-only mode remains fully usable without any login.

### Device and enrollment bearer tokens

Use high-entropy machine-generated bearer tokens with an indexed public ID and
an efficient keyed digest:

```text
token = public_token_id + "." + random_secret

server stores:
  public_token_id
  HMAC-SHA-256(deployment_token_key, random_secret)
```

Requirements:

- the random secret has sufficient cryptographic entropy;
- the deployment token key is supplied outside PostgreSQL through typed,
  redacted secret configuration;
- lookup uses the public ID, then comparison is constant-time;
- plaintext token is returned exactly once and never stored server-side;
- logs, diagnostics, URLs, SSR payloads, and wide events never contain it;
- key version supports deployment-key rotation; Device credentials support
  explicit rotation/revocation;
- short-lived high-entropy enrollment grants may use the same public-ID/HMAC
  design;
- Argon2id is not used for per-request verification of these random tokens.

Authentication, authorization, TLS, generation rules, credential revocation,
batch identity, and idempotency jointly constrain replay. Idempotency prevents
duplicate application of an already submitted logical batch; it is not a
complete defense against a stolen credential.

### Identity separation

Keep these concepts separate:

```text
Person
  human represented by ai-usage

Authentication identity
  verified GitHub provider subject used to log in

SCM account
  Person-scoped provider identity; person_id required

SCM installation
  Space-scoped GitHub App/organization repository grant
  provider installation ID + selected repositories

SCM credential
  recoverable encrypted secret/reference attached to one account or installation

Device
  local runtime identity

Device credential
  revocable bearer secret used for publication
```

GitHub login and repository installation are separate user actions, scopes,
tables, revocation paths, and audit events.

## Existing repository work to reuse

- `packages/usage-engine-control/src/secret.ts` stores secret values out of the
  serializable object and renders `[REDACTED]`. Reuse the redacted-object
  discipline for Device tokens while retaining distinct brands/accessors.
- Owner-only/no-follow file creation already exists in local storage and the
  `UsageEngineHandoff*` transport. Reuse `0o700` parent, `0o600` file,
  exclusive/no-follow creation, atomic replacement, and identity revalidation.
- Principal authorization is plan 103's domain; `SourceAuthority` is unrelated
  filesystem provenance.

## Schema direction

```text
people                         existing from plan 102
authentication_identities      person_id NOT NULL, provider_subject stable/unique
web_sessions                   verifier/hash metadata, expiry, revocation, assurance
scm_accounts                   person_id NOT NULL, provider account identity
scm_installations              space_id NOT NULL, installation ID, repository selection
scm_credentials                account_id XOR installation_id, encrypted secret/reference
devices                        existing identity/lifecycle from plan 102
device_credentials             public_token_id, keyed_digest, key_version,
                               created/last_used/rotated/revoked timestamps
device_enrollment_grants       public_token_id, keyed_digest, key_version,
                               Person/Space/label scope, expiry, consumed_at
identity_events                content-free audit records
```

Database constraints enforce required Person/Space scope and exactly one SCM
credential owner. No nullable `scm_accounts.person_id` represents an
organization installation.

OAuth/installation secrets that must be recovered are envelope-encrypted or
stored through a recoverable secret reference with keys outside PostgreSQL.
Device/enrollment random secrets are not recoverable and use HMAC verifiers.

## GitHub sign-in and repository connection

### Sign in with GitHub

- request only identity scopes needed for login;
- store the stable provider subject ID, not username/email as identity;
- create/link an Authentication Identity to a Person through explicit verified
  flows;
- never expose provider tokens to browser code or local collectors.

### Connect GitHub repositories

- install/authorize a GitHub App or equivalent connection separately;
- bind installation and selected repositories to an authorized Space;
- resolve stable provider repository IDs and rename events;
- do not grant login to organization members or organization ownership to
  personal captures;
- keep credentials in the SCM credential boundary and out of Device/local
  collector state unless a later explicitly authorized feature requires them.

## First-owner bootstrap

V1 flow:

1. deployment has zero People;
2. explicit typed config enables first-owner bootstrap;
3. a user completes normal GitHub sign-in successfully;
4. one transaction/advisory lock creates the Person, personal Space, and owner
   relation if and only if the deployment still has zero People;
5. the bootstrap path becomes inert permanently after success, even if config
   remains enabled;
6. concurrent GitHub callbacks create at most one first owner;
7. the event is audited without OAuth credentials.

There is no separate bootstrap credential that substitutes for login, no
first-request-wins rule, and no support for a user unable to authenticate with
GitHub. Public signup is a separate deployment policy.

## Web session contract

- `HttpOnly`; `Secure` under HTTPS; `SameSite=Lax` for OAuth callback;
- `__Host-` cookie prefix where deployment requirements permit;
- bounded idle and absolute expiry;
- rotation after login/linking/privilege or assurance changes;
- CSRF protection for cookie-authenticated mutations;
- OAuth state/PKCE/nonce validation as applicable;
- explicit logout and revoke-all;
- browser local storage/SSR never receives auth/provider secrets;
- every session resolves to a Person principal and still calls `Authorizer`.

Auth-library row types remain adapter-private. oRPC/domain contracts use
explicit validated identity/session results.

## Account linking

- requires an authenticated session plus fresh proof of the new identity;
- matching email/handle never auto-merges People;
- conflicts require explicit recovery/admin review;
- unlinking cannot remove the last viable V1 login identity;
- Authentication Identity linking remains distinct from SCM account linking;
- every link/unlink is audited.

Tests include personal and professional GitHub identities linked explicitly to
one Person, plus same-email identities that remain separate without approval.

## Device enrollment

### Grant

An authenticated Person requests a grant for a chosen Space and label.
`Authorizer` decides whether the Person may enroll there. The server creates a
single-use, 15-minute high-entropy token in public-ID/HMAC form and returns the
plaintext once.

### Exchange

The CLI/local runtime submits the grant over TLS. In one transaction the server:

1. looks up public ID and verifies the HMAC in constant time;
2. verifies expiry, unconsumed state, Person/Space scope, and authorization;
3. atomically consumes with a guarded update;
4. activates the Device;
5. creates a separate Device credential using the same public-ID/HMAC design;
6. returns that plaintext credential once.

Two concurrent exchanges yield exactly one Device/credential.

### Local storage

Prefer an OS keychain when a complete implementation exists. V1 may use the
existing owner-only/no-follow private file discipline with limitations
documented. The redacted domain value cannot serialize/interpolate plaintext;
only a narrow transport accessor can reveal it.

### Lifecycle

Support list/rename, credential age, last seen, rotation, revoke one, and revoke
all. Rotation specifies atomic cutover or a short explicit overlap identified by
credential IDs. Revoked credentials fail before ingest authorization, while
historical Device provenance remains readable to authorized users.

## Service principals

Background jobs use explicit narrow service principals through `Authorizer`.
Running inside `apps/server` is not an authorization bypass. Replication,
indexing, aggregation, credential cleanup, and archive retention each document
and test their permissions.

## Local-only mode

- no login screen or auth redirect blocks Usage, Skills, Memory, search, MCP, or
  local Work handoffs;
- `SingleUserAuthorizer` supplies the local principal;
- shared authentication configuration is absent from local client bundles;
- adapter selection cannot be changed by an attacker-controlled request header;
- local tests inject a platform/auth adapter that throws if invoked and assert
  zero calls. They do not inspect global PostgreSQL processes.

## Audit and privacy

Audit coarse login result classes, bootstrap, linking/unlinking, session revoke,
SCM connection changes, Device grant/exchange/rotation/revocation, and deployment
token-key rotation. Store stable IDs and bounded codes only. Never store OAuth
codes, tokens, password fragments, raw IP history, or user-agent dumps without
an explicit retention policy.

## Steps

### Step 1: Verify Better Auth against the current runtime

In an isolated spike, prove Bun/SvelteKit, Drizzle/PostgreSQL, GitHub OAuth,
session security, and explicit linking. Record the exact version/constraints in
the ADR, delete throwaway code, and stop on failure.

### Step 2: Add separated identity/credential schema

Add Authentication Identity, Web session, SCM installation, SCM credential,
Device credential, and enrollment grant tables while preserving the required
Person owner on every `ScmAccount`. Add typed deployment secret config with
redaction and key version.

### Step 3: Add GitHub login and Web sessions

Wrap the library behind identity application services. Test stable subject
identity, repeated sign-in, separate accounts, cookie/CSRF/expiry/rotation, and
no secret/provider-token leakage.

### Step 4: Add first-owner GitHub bootstrap

Test zero-People + enabled + successful GitHub sign-in, concurrent callbacks,
flag left enabled after success, disabled config, and the explicit unsupported
no-GitHub case.

### Step 5: Add Device enrollment with public-ID/HMAC tokens

Test grant expiry, one-time plaintext, concurrent exchange, constant-time
verification, key version/rotation, redacted rendering, private local storage,
and no token logs. Do not benchmark Argon2id because it is not this verifier.

### Step 6: Add lifecycle, linking, and service principals

Test revoke/rotate, stolen-old-token failure after cutover, historical
provenance, same-email no-link, last-auth-method protection, and narrow job
principals.

### Step 7: Prove local independence

Run representative local flows with platform/auth adapters that fail on call;
assert no redirect and zero calls. Do not use `pgrep` as evidence.

### Step 8: Document support boundaries

Document GitHub-only connected login, unsupported self-hosters without GitHub,
local no-login mode, identity separations, HMAC token threat model, replay
limitations, key rotation, private-file limitations, and future human-password
Argon2id scope.

## Verification

- Better Auth spike passes or implementation stops;
- GitHub sign-in and SCM installation are separate flows;
- `ScmAccount.personId` is required and installations are Space-scoped;
- Device/enrollment verification uses public ID + HMAC + constant-time compare;
- plaintext secrets are one-time and absent from storage/logs;
- bootstrap requires successful GitHub authentication and is concurrency-safe;
- local tests record zero shared auth/platform calls;
- authorization conformance, lint, typecheck, identity/server tests pass.

## Done criteria

- [ ] GitHub is the only normal V1 shared login and the unsupported cases are
      explicit.
- [ ] First-owner bootstrap authorizes the first GitHub identity only.
- [ ] Person, Authentication Identity, SCM account, SCM installation, SCM
      credential, Device, and Device credential remain distinct.
- [ ] Machine-generated tokens use public ID + keyed digest, not Argon2id.
- [ ] Rotation/revocation/key-version/no-log behavior is tested.
- [ ] Replay claims correctly combine auth, TLS, generations, revocation, batch
      identity, and idempotency.
- [ ] Local mode needs no login or shared-server call.

## STOP conditions

Stop and report when:

- shared login works only by broad repository scopes;
- first-owner bootstrap is claimed to support no-GitHub users;
- a partial password/passkey/custom bootstrap-session system is proposed;
- random Device/enrollment tokens are verified with an intentionally expensive
  password hash on every request;
- token comparison is not constant-time or the deployment key lives in the DB;
- an installation is represented by weakening the required Person owner on an
  SCM account;
- provider/Device tokens reach browser, logs, collectors, or URLs;
- Device enrollment bypasses `Authorizer`;
- local mode requires a remote Web session.

## Out of scope

- password/passkey/email login and recovery;
- connected mode for self-hosters without GitHub authentication;
- SAML/SCIM/directory sync;
- mandatory MFA;
- remote Device commands or LAN enrollment;
- organization billing.
