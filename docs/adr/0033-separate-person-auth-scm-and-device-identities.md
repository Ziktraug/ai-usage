# ADR 0033: Separate Person, authentication, SCM, and Device identities

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

A GitHub login, provider account, provider installation, recoverable provider
secret, local Device, and Device credential answer different ownership and
security questions. Collapsing them can assign organization content from a
repository grant, make one human depend on one login, or treat a hostname as a
credentialed principal.

## Decision

Model these concepts independently:

- Person is the stable human identity;
- Authentication identity is one verified login linked to a Person;
- SCM account is a Person-scoped provider identity with required `person_id`;
- SCM installation is a Space-scoped provider installation/repository grant;
- SCM credential is an encrypted recoverable secret/reference attached to
  exactly one account or installation;
- Device is a stable local runtime identity;
- Device credential is a separate enrollment/authentication secret and
  verifier record.

No path, Repository, SCM account/installation, login, Device, hostname, or
usage-machine record silently assigns organization ownership. Capture Context
records Person, Device, Space, optional Project, and optional SCM identities
before publication. Connected V1 normal login is GitHub-only; local mode needs
no login.

## Consequences

- People can link or rotate identities and credentials without changing domain
  ownership.
- Organization grants do not implicitly expose personal content.
- Enrollment, revocation, SCM access, and authentication retain distinct audit
  and lifecycle rules.

## Rejected alternative

One nullable provider-account table for users, installations, and credentials
was rejected because nullability would encode incompatible ownership semantics
and invite authorization shortcuts.

## Reversal condition

Merge concepts only if a provider supplies a formally identical owner,
lifecycle, credential, and authorization model and migration proves no loss of
Person/Space separation; presentation convenience alone is insufficient.

## Evidence

- [Identity language](../../CONTEXT.md)
- [Plan 102](../../plans/102-spaces-people-devices-repositories-projects.md)
- [Plan 104](../../plans/104-authentication-github-device-enrollment.md)
