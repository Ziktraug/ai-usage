# Publication checklist

This file prepares publication metadata and review steps. It records no completed external action.

## Exact GitHub repository copy

**Description**

> Local CLI and dashboard for exploring AI coding-tool usage across Codex, Claude Code, OpenCode, and Cursor.

**Topics**

```text
ai
developer-tools
usage-analytics
local-first
bun
typescript
solidjs
```

**Homepage**

Leave unset until an owner-approved hosted project page exists. The repository does not currently offer a hosted demo.

**Optional announcement copy**

> ai-usage brings local Codex, Claude Code, OpenCode, and Cursor session usage into one CLI and Solid dashboard. Explore trends, filter thousands of sessions, and inspect detail without sending normal report data to a hosted analytics service. A deterministic `bun run demo` is included for a privacy-safe local tour.

## README claim review

- [ ] Reconfirm supported harnesses against the current collectors.
- [ ] Reconfirm that API-equivalent value is described as an estimate, not savings or ROI.
- [ ] Retain the Codex `app-server` quota exception and Cursor partial-data qualification.
- [ ] Confirm the demo command still uses only committed synthetic data and loopback.
- [ ] Confirm the hero was recaptured from the demo and contains no operator data.
- [ ] Re-run the linked frontend and performance evidence before changing numerical claims.

## Manual repository publication

- [ ] Review the MIT holder and year.
- [ ] Review `CONTRIBUTING.md`, `SECURITY.md`, and the private advisory link.
- [ ] Apply the exact description and topics above in GitHub repository settings.
- [ ] Leave Homepage blank unless a reviewed public page exists.
- [ ] Verify branch protection, required checks, and Security Advisories in GitHub.
- [ ] Create a release only after selecting a version, reviewing the diff, and running every documented gate from a clean checkout.
- [ ] Publish announcement copy only after the release URL exists.

No repository metadata, release, pull request, hosted demo, or announcement is created by this checklist.
