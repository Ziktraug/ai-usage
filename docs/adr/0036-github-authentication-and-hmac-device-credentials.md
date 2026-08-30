# ADR 0036: GitHub authentication and HMAC Device credentials

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

Connected mode needs a verified human principal and revocable Device trust
without making GitHub, a Web session, or a recoverable provider token the
domain identity. A custom session stack would duplicate security-sensitive
OAuth, cookie, CSRF, state, and PKCE behavior. Password support would also need
recovery, verified email, abuse controls, and a separate deployment policy that
V1 does not have.

## Decision

Connected V1 uses Better Auth `1.7.2`, pinned exactly, behind
`@ai-usage/identity` application services. The isolated compatibility spike
proved the repository's Bun `1.3.13`/SvelteKit request boundary, the matching
`@better-auth/drizzle-adapter` `1.7.2` with PostgreSQL, GitHub OAuth/PKCE,
secure cookies, database-backed state, encrypted provider tokens, and explicit
account linking. Auth-library rows and APIs remain adapter-private.

GitHub is the only normal shared login. It requests exactly `read:user` and
`user:email`, identifies an Authentication identity by the stable GitHub
subject, disables implicit/email-based linking, and requires an authenticated
explicit OAuth proof to add another identity. Internally generated provider
emails are subject-derived and non-routable, so a matching provider email or
handle cannot merge People. Linking invalidates existing sessions and requires
a new login; unlinking the last active GitHub identity is denied.

Web sessions use a raw high-entropy cookie only at the HTTP boundary and store
its SHA-256 digest in PostgreSQL. HTTPS cookies are `HttpOnly`, `Secure`,
`SameSite=Lax`, host-only `__Host-` cookies. Sessions are non-sliding and
bounded to 24 hours, with 15 minutes of freshness. Cookie-authenticated
application mutations require the configured exact Origin. Login creates a
new session, linking invalidates every existing session, and logout/revoke-all
delete sessions.

Device credentials and 15-minute enrollment grants use a different token:

```text
public_token_id.random_secret
```

PostgreSQL stores the indexed public ID, key version, and
`HMAC-SHA-256(deployment_key, random_secret)`. Deployment keys remain in typed,
redacted process configuration. Verification selects by public ID and compares
the digest in constant time. Plaintext is returned once, never stored by the
server, and is not a GitHub token or Web session. Device credential rotation is
an atomic cutover; revocation preserves the Device and its provenance.

Local mode remains login-free and imports no shared-authentication composition.
V1 may store its Device credential in the dedicated owner-only private file
adapter; an OS keychain can supersede that adapter without changing the token
or server contracts.

## Consequences

- A connected self-hoster needs usable GitHub OAuth configuration; password,
  passkey, email-link, and no-GitHub connected login are unsupported.
- Provider-token recovery, Web sessions, Device verification, and domain
  authorization keep independent tables and revocation paths.
- Replay resistance combines TLS, high entropy, key generations, credential
  rotation/revocation, future publication generations/batch identity, and
  idempotency. Idempotency alone does not neutralize a stolen credential.
- Old deployment keys must remain available until every credential/grant or
  session that references them is rotated or expired.

## Rejected alternative

A partial custom password/bootstrap-session implementation was rejected because
it would authenticate neither GitHub-less users safely nor provide the required
recovery, verified-email, abuse-control, and session-security system.

## Reversal condition

Add another human login only after its complete proof, recovery, abuse,
bootstrap, linking, and deployment support is accepted. Replace Better Auth or
the private-file adapter only when parity tests preserve the application-owned
contracts and migration path.

## Evidence

- [Authentication and Device enrollment](../authentication-and-device-enrollment.md)
- [Identity separation](0033-separate-person-auth-scm-and-device-identities.md)
- [Plan 104](../../plans/104-authentication-github-device-enrollment.md)
