# Design: Adopt an Unmanaged Runtime Entry Into the Source Repository

> Deliverable of **plan 083 Phase A**. This document decides the shape of the
> adoption feature; it does **not** implement it. Phase B is gated behind
> explicit maintainer approval.
>
> Written at `462758ce` (base `5e4cf954`). Drift check for the plan's four
> anchor paths returned empty — the "Current state (verified)" excerpts in
> plan 083 still hold.

## What this document decides

Plan 083 asks eight questions. Sections 3.1–3.8 answer each with a
recommendation, the reasoning, and the alternative that was rejected.
Section 2 is the measured entry-shape inventory that the complexity budget
follows from; it changed three of the plan's provisional recommendations, so
read it first.

---

## 1. The structural finding that reframes the feature

Adoption is not one capability wired to two dead-ends. The two dead-ends
address **two different domain objects**, and only one of them is an
`UnmanagedEntry`.

`packages/skills/src/projections.ts:196` skips any target entry whose name
matches a source skill:

```
if (managedSkillNames.has(entry.name)) { continue; }
```

So the partition is:

| Situation | Domain object | Where it surfaces |
|---|---|---|
| Runtime entry whose name is **not** a source skill | `UnmanagedEntry` (`contracts.ts:131`) | `snapshot.unmanagedEntries` → the consolidate panel |
| Runtime entry whose name **is** a source skill, but is a real directory instead of a managed symlink | `Projection` with `state: 'unmanaged-copy'` (`projections.ts:164`) | `snapshot.projections` → the health/matrix surfaces |

The plan's question 2 ("name collisions with an existing source skill") is
therefore **not an edge case inside the adopt flow — it is a different entry
point.** A colliding entry never reaches `unmanagedEntries` at all. This
machine has 5 such projections and 0 colliding unmanaged entries (§2.5),
which means a v1 that only reads `unmanagedEntries` is structurally unable
to hit the collision case, and a v1 that refuses collisions must refuse them
in the `Projection` channel where they actually live.

Consequence for the design: `AdoptPlan` is keyed by **(targetId,
entryName)** — a discovered runtime coordinate — not by `skillName`. Both
channels can produce that key. The planner then classifies.

---

## 2. Step A1 — Entry-shape inventory (measured, read-only)

Method: `loadSkillManagementSnapshot` against this machine's real config
(`~/.config/ai-usage/config.json`, `skills.sourceRepoPath` set, no `targets`
override so `buildDefaultSkillTargets` applies), then a read-only walk of
every reported entry. Scripts live in the session scratchpad and are not
committed. Nothing was mutated.

Paths below are generalised (`~/…`, `<upstream>`) — the shapes are the
finding, not the user's directory layout.

### 2.1 Scale

| Measure | Value |
|---|---|
| Source skills | 2 (both `validationStatus: 'warning'`) |
| Observed targets | 4 of 6 (`standard-agents`, `claude-code`, `codex`, `opencode`; `github-copilot` and `cursor` disabled + missing) |
| Healthy projections | **0** |
| Unmanaged entries | **182** |
| Projections in `unmanaged-copy` | 5 |

The consolidate panel is currently showing a 182-item backlog against a
2-skill source repo. Adoption is not a nicety here; the panel is the whole
product surface for this machine's state.

### 2.2 Split by state and kind

| | count | share |
|---|---|---|
| `unmanaged-symlink` | 152 | 84% |
| `unmanaged-copy` | 30 | 16% |
| plain-file entries (`SKILL.md` sitting directly in the target) | **0** | — |

By target: `standard-agents` 64, `claude-code` 44, `opencode` 43, `codex` 31.

**The dominant shape is not a copy.** The plan's framing ("skills live
directly in runtime folders") describes 16% of the real backlog.

### 2.3 Where the 152 symlinks point

| Destination root | links | of which broken |
|---|---|---|
| A Nix-managed generator tree (`~/…/global-skills/.cache/<upstream>/…`) | 96 | 18 |
| A second skills repository (`~/…/agent-skills/skills/…`) | 54 | 54 |
| Another **runtime target** (`~/.agents/skills/…`) | 2 | 1 |
| Into the configured source repo | **0** | — |

- **73 of 152 (48%) are broken links.** The second skills repo no longer
  contains those skills; the links were never cleaned up.
- 63 distinct canonical destinations serve 152 links; 40 destinations are
  linked from 3–4 targets each. Cross-target sharing is already achieved
  *by symlink*, from a generator.
- 2 links use relative specs; the rest are absolute.
- One link (`claude-code/improve → ~/.agents/skills/improve`) points at an
  entry that is *itself* an unmanaged copy in a different target — a chained
  case.

This is the single most decision-relevant number in the inventory: the
majority of the "consolidation backlog" is **owned by another tool**. A Nix
rebuild recreates those symlinks. Adopting them would fork content away from
its generator and be silently reverted on the next rebuild.

### 2.4 The 30 directory entries

| Shape | count |
|---|---|
| Single `SKILL.md` only | 21 |
| `SKILL.md` + real reference files (up to 12 files, 1 nested dir, ≤68 KB) | 2 |
| **Link-farm directory** — a real directory whose every leaf is a *symlink* into the generator tree | 6 |
| **`codex/.system`** — 85 entries, 26 nested dirs, 59 files, 380 KB, no root `SKILL.md`; each child is itself a skill | 1 |

Other measurements: 0 executable files anywhere; file counts min 0 / p50 1 /
p90 4 / max 59; bytes min 0 / p50 4.3 KB / p90 44 KB / max 380 KB; non-`.md`
extensions observed inside entries: `.d.ts`, `.ts`, `.cjs`, `.mjs`, `.py`,
`.yaml`, `.txt`, `.png`, `.svg`, `.marker`, and one extensionless file.

Two shapes here are **not covered by plan 083's Phase-B sketch**, which
triggers the plan's STOP condition "the snapshot inventory reveals entry
shapes the design did not cover — extend the design first". This document
extends it (§3.3, §4.3):

1. **Link-farm directories.** `lstat` on the entry says "directory", so it
   is classified `unmanaged-copy`; but `SKILL.md` and
   `references/memory-contract.md` are symlinks (all broken on this
   machine). A naive recursive copy either copies dangling links into the
   source repo or silently dereferences another repo's bytes. Both are
   wrong.
2. **`codex/.system`.** A runtime-owned namespace directory, not a skill.
   The contract layer already knows about it — `packages/web-contract/src/skills.ts:57–60`
   carries the comment *"A runtime target may hold any directory entry,
   including names a managed skill could never carry (Codex writes its own
   `.system` directory)"* and relaxes `discoveredEntryNameSchema` for it.
   The **product** layer never learned: the consolidate panel offers to
   consolidate it. Adopting it would move a Codex-internal tree out of
   Codex's directory.

Binary payloads (`.png`, `.svg`) and TypeScript declaration files exist
inside entries, so any copy must be byte-exact, not text-normalised.

### 2.5 Name collisions and cross-target duplicates

- Unmanaged entries colliding with a source skill name: **0** (by
  construction, §1).
- Projections in `unmanaged-copy`: **5** — two skill names, one appearing in
  3 targets and one in 2.
- Directory entries sharing a name across targets: 3 names. Their structural
  content:

  | Name | targets | identical real bytes? |
  |---|---|---|
  | link-farm A | 2 dirs (+2 symlink entries elsewhere) | identical, but both are link farms |
  | link-farm B | 3 dirs (+1 symlink entry) | identical, but all are link farms |
  | a real skill | 1 dir + 1 symlink pointing at that dir | n/a |

- **Pairs of directory entries with identical real (non-link) file content
  across targets: 0.**

So the plan's question 4 ("adopt once + batch-convert identical copies")
describes a case this machine **does not exhibit even once**. Every
apparent duplicate is duplicated by a symlink or by a generator. §3.4
recommends accordingly.

### 2.6 Entry names

One entry name (`.system`) fails `skillNamePattern`
(`packages/skills/src/shared.ts:1`). Everything else is valid kebab-case.
`parseSkillName` would throw on `.system`, so any adopt planner that derives
a skill name by calling `parseSkillName(entry.entryName)` must catch rather
than throw — a thrown error in the planner would take down the whole
preview, exactly the failure mode `discoveredEntryNameSchema` was introduced
to avoid at the contract layer.

---

## 3. The eight questions

### 3.1 Move or copy?

**Recommendation: copy → hash-verify → quarantine-by-rename → symlink, in
that order, journalled, under `withSkillProjectionLock`.** Never `move` in
the sense of destroying the runtime bytes.

Order matters and the plan's ordering is the right one: the source repo gets
a verified copy *before* the runtime entry is disturbed, so the abort path
before quarantine costs nothing but a stray directory in the source repo.

`rename()` cannot replace a non-empty directory with a symlink (`ENOTEMPTY`
/ `EISDIR`), so the swap is two steps. The recoverable protocol:

| Phase | Action | Filesystem state after |
|---|---|---|
| `planned` | write journal to private state | nothing user-visible changed |
| `copied` | byte-exact copy to `<source>/.ai-usage-adopt/<opId>/<name>/`, digest-verify, then `rename` to `<source>/skills/<name>` (atomic; destination must not exist) | source has the skill; runtime untouched |
| `quarantining` | **append the quarantine index entry**, then `rename(entryPath, quarantinePath)` — atomic for a directory | **runtime entry absent** (the only exposed window) |
| `linked` | `symlink(<source>/skills/<name>, entryPath)` | managed projection in place |
| — | delete the journal — **last**, after the index entry is durable | done |

The index write is ordered **before** the quarantine rename, not after journal
deletion. A crash between the index write and the rename leaves an index entry
whose `quarantinePath` does not exist; the recovery scan reconciles it (path
missing and the original still at `entryPath` → drop the index entry). The
reverse ordering — journal deleted first, index appended after — would leave a
quarantined original with no journal *and* no index entry, i.e. a preserved
directory that the designed recovery mechanism can never find. That inversion
is the reason the index write is a phase step rather than a bookkeeping tail.

Crash recovery (`recoverAdoptWrite`, modelled directly on
`recoverSkillMarkdownWrite`, `packages/skills/src/skill-markdown-io.ts:295`,
which already runs this exact journal+claim+temp pattern for `SKILL.md`
writes with phases `claimed | prepared | published`):

- crash in or after `planned` (**including mid-copy**) → the staging
  directory `<source>/.ai-usage-adopt/<opId>/` may be partially populated.
  Recovery removes it — the `opId` in the path makes ownership unambiguous,
  the same trick `skillMarkdownTempNamePattern`
  (`skill-markdown-io.ts:129,153–155`) uses to prove a temp belongs to a
  journalled operation — then re-runs from scratch. Removing an
  ai-usage-created staging copy is not deleting user bytes: the original is
  still untouched at `entryPath`, and the staging tree's only content is a
  copy of it. Staging lives **outside** `<source>/skills` precisely so a
  half-written tree is never scanned (`scanSkillSourceRepository` would
  otherwise emit `InvalidSkillDirectoryName` for a dot-prefixed leaf,
  `source-scan.ts:174–185`).
- crash after `copied` → destination exists. Recompute its digest: matches
  the journal → resume at `quarantining`; differs → **blocked**, with a
  diagnostic naming the path (the user edited it; the tool must not
  overwrite).
- crash inside `quarantining` → decided by `lstat(quarantinePath)`, which is
  unambiguous because **nothing pre-creates the leaf** (see below): it exists
  ⇒ the rename completed ⇒ resume at `linked`; it is missing ⇒ the rename did
  not happen ⇒ drop the orphan index entry and retry from `copied`.
- crash after `quarantining` → the vacated path is missing and the
  quarantine path holds the original. Resume at `linked`. Idempotent.
- crash after `linked` → journal deletion is the only remaining step.

Every phase is re-runnable and no phase deletes bytes that exist only in the
runtime target or the quarantine.

**Quarantine location.** Recommendation:
`<dirname(target.path)>/.ai-usage-skill-quarantine/<entryName>.<opId>/`
— e.g. a target at `~/.claude/skills` quarantines into
`~/.claude/.ai-usage-skill-quarantine/`. Created `0700`.

Rationale: it is the *smallest* enclosing directory that (a) is
overwhelmingly likely to share a filesystem with the target, so the rename
is atomic, and (b) is **outside the scanned skills directory**, so a
quarantined original never reappears as a new unmanaged entry. Collision
naming is `<entryName>.<opId>` with `opId` a fresh UUID.

**The leaf is never pre-created.** Only the shared
`.ai-usage-skill-quarantine/` directory is `mkdir`-ed (`0700`, idempotent);
the leaf comes into existence *as the rename's destination*. Under the lock,
immediately before the rename, `lstat(quarantinePath)` must return `ENOENT`
— anything else means a previous crashed operation reused the id, so
`adopt-blocked: quarantine-occupied`. This is what makes the `quarantining`
recovery predicate above decidable: an existing leaf can only mean "the
rename completed", never "a reservation was made". Reserving the leaf with
`mkdir` first would make the two states indistinguishable and is the reason
this design does not do it.


**The quarantine root is verified, never trusted.** The leaf check above is
only decidable if the directory containing it is the directory this design
means. `.ai-usage-skill-quarantine/` sits in a directory the user can write
to, so an idempotent `mkdir` is not enough: `mkdir` on an existing **symlink
to a directory** succeeds (`EEXIST`, swallowed by the idempotent path), and
the quarantine rename then lands wherever that symlink points — outside the
projection root, possibly outside `$HOME`. Under the lock, before the
`mkdir` and again before the rename:

- `lstat` the quarantine root — never `stat`, which resolves the final
  symlink and reports the *target's* type.
- Refuse a symlink outright, whatever it points at, and refuse any type
  that is not a directory.
- Compare `realpath(quarantineRoot)` against
  `join(realpath(dirname(target.path)), '.ai-usage-skill-quarantine')` —
  the caller-supplied string is not evidence.
- A root that fails any check is **never replaced, removed, or adopted**:
  emit `adopt-blocked: quarantine-root-unsafe`, naming what was found
  (symlink → its target, or the actual file type), and leave the runtime
  entry untouched. Repairing it is a user decision, not the tool's.
- A root that passes is reused as-is; a collision on the *leaf* inside it
  is the already-defined `adopt-blocked: quarantine-occupied`, which is a
  different condition and keeps its own diagnostic.

- Rejected: quarantine *inside* the target (`<target>/.ai-usage-…`). That is
  what `claimObservedProjection` (`projections.ts:430`) does for its
  transient `.old` claim, and it is fine transiently — but a *permanent*
  quarantine there becomes a new unmanaged entry on the next scan, exactly
  the `.system` failure mode.
- Rejected: quarantine in `~/.config/ai-usage/`. Clean conceptually, but a
  different filesystem from the target is plausible (separate `/home` mount,
  a container bind-mount), and `rename` would fail `EXDEV`. Falling back to
  copy-then-delete would delete user bytes — forbidden by "nothing is ever
  deleted automatically" in its strictest reading.
- On `EXDEV`/`EPERM` from the quarantine rename: **refuse** the entry with
  `adopt-blocked: cross-device-quarantine`. Do not fall back.

The quarantine **index** (`~/.config/ai-usage/skills-quarantine.json`,
atomic write) records `{ opId, targetId, entryName, quarantinePath,
adoptedAt, digest }` so the recovery scan and any future "clean up
quarantine" UI do not have to walk every target's parent directory. The
index is a record, not the authority: the directories are the authority.

**Recovery scan.** On snapshot load, read the journal directory
(`~/.config/ai-usage/skills-adopt-journals/`); for each journal, run
`recoverAdoptWrite`. A journal stuck in `quarantined` means a runtime entry
is currently missing — that is the one state the UI must surface loudly.
This mirrors `scanOneSkill`'s existing `recoverMarkdownWrites` call
(`source-scan.ts:188`).

### 3.2 Name collisions with an existing source skill

**Recommendation: refuse, with `adopt-blocked: name-collision`, in v1.**
Confirmed — but relocated: per §1 the collision surfaces as a
`Projection` in `unmanaged-copy`, not as an `UnmanagedEntry`, so the refusal
must be produced by the planner when the requested `(targetId, entryName)`
resolves to an existing source skill name. The diagnostic should carry the
source skill's path so the user can diff the two by hand.

Alternative considered and rejected: adopt-as-new-name (e.g.
`<name>-from-<targetId>`). It produces a source repo full of near-duplicates
whose relationship is encoded only in a name suffix, and the user's actual
intent — "these two should be one skill" — is a merge, which is a separate
feature with its own diff UI. Merging in v1 would also have to answer "which
side wins per file", which nothing in the current domain can express.

Note for Phase B: a future "compare and merge" flow is the natural
successor, and this machine's 5 colliding projections are its first users.

### 3.3 Validation gate

**Recommendation: parse and validate *before* any bytes move; refuse on
anything worse than `warning`.**

Concretely, the planner must run the same pipeline the source scanner runs —
`parseSkillMarkdown` then `validationStatusFor`
(`packages/skills/src/skill-markdown.ts:107`) — against the entry's
`SKILL.md`, and block when:

| Condition | Blocked reason |
|---|---|
| `validationStatus === 'invalid'` | `invalid-skill-content` |
| no `SKILL.md` at the entry root | `not-a-skill` |
| entry name fails `skillNamePattern` | `reserved-entry-name` |
| any child of the entry is itself a skill directory (a nested collection) | `nested-skill-collection` |
| the entry tree contains a symlink at any depth | `nested-symlink-payload` |
| files exceed `defaultMaxFilesPerSkill` or bytes exceed a copy budget | `entry-too-large` |

`warning` status (heavy tokens, unknown frontmatter fields) stays adoptable
— this matches `planProjection`'s existing stance at `projections.ts:310–320`
("Warning-status skills … stay projectable; only structurally invalid skills
are refused"), and both source skills on this machine are `warning`, so a
stricter gate would refuse the user's own working skills.

The last three rows are the §2.4 extension. `nested-symlink-payload` is the
link-farm case: 6 of 30 directory entries on this machine hit it, and there
is no defensible copy semantic (copy the dangling link? dereference someone
else's repo?). `nested-skill-collection` plus `reserved-entry-name` together
cover `codex/.system` twice over.

**A recommended prerequisite, cheap and independently valuable:** apply the
`not-a-skill` / `reserved-entry-name` classification to the *consolidate
panel itself*, so `.system` and empty leftovers stop being presented as
consolidation work. That is 176 → a materially smaller honest backlog and
does not depend on adoption shipping.

Rejected: "adoptable into a quarantined state". It adds a third lifecycle
state to the source repo that nothing else understands, and the source
scanner would immediately report the quarantined skill as invalid anyway.
Refusal with a precise reason is strictly more useful.

#### 3.3a Does copying reference files violate "editing non-`SKILL.md` files"?

Plan 083's out-of-scope list says *"Editing non-`SKILL.md` files (future-work
defers it behind a safety model)"*. Read narrowly that is a bound on the
**editor** — `writeSkillMarkdown` / `saveManagedMarkdown` operate on
`SKILL.md` only (`packages/skills/src/skill-markdown-io.ts`), and this design
does not extend them. Read broadly it could be taken to bar *writing* any
non-`SKILL.md` byte, which would mean a `SKILL.md`-only v1.

**Recommendation: byte-exact whole-entry copy; the narrow reading is the
right one.** The reasoning is not convenience:

- A `SKILL.md`-only adoption would quarantine the *entire* entry (the swap is
  a directory rename; it cannot leave `references/` behind) and then project
  a source skill that is missing files the runtime skill had. The user's
  working skill would silently lose its references — a data-loss outcome
  strictly worse than not adopting.
- Copy is not edit. No file's bytes are transformed, no content is parsed or
  rewritten, and the digest verification proves the copy is identical. The
  safety model future-work is deferring is about *mutating* arbitrary files
  in place; verbatim replication has none of that risk surface.
- The inventory bounds the blast radius: 21 of the 23 adoptable entries are
  `SKILL.md`-only anyway, and the two multi-file entries are 4 and 12 files
  of markdown and `.d.ts`. The copy budget in §3.3 (`entry-too-large`) caps
  it.

**The alternative, stated plainly so the maintainer can choose it:** restrict
v1 to entries whose only file is `SKILL.md` (`adopt-blocked:
multi-file-entry`). That covers 21 of 23 adoptable entries here, is
unambiguously inside the narrow out-of-scope reading, and defers the copy
budget entirely. It costs the two real multi-file skills on this machine and
adds one more blocked reason the user cannot act on. **If the maintainer
reads the out-of-scope line broadly, take this alternative — do not build the
whole-entry copy and then trim it later.**

### 3.4 Identical-content duplicates across targets

**Recommendation: adopt once + convert every matching entry — `adopt-relink`
is REQUIRED in v1, not optional.** This is a change from the position that
"zero observed instances" first suggested, and the reason is a soundness
argument rather than a frequency argument.

Pure per-entry adoption is not merely inefficient for duplicates, it is
**unresolvable**. Two targets holding the same-named entry both resolve to
the same destination `<source>/skills/<name>`. Adopting from target A creates
that source skill. Target B's entry now collides with a source skill name, so
§3.2 blocks it as `name-collision` — *permanently*, with no action that
clears it. The user would be told to hand-merge two byte-identical
directories. Any v1 without `adopt-relink` therefore ships a state machine
with a dead end, which is the exact defect this whole plan exists to remove.

Design: the planner computes a content digest per adoptable entry (it must
compute one regardless, for the copy verification in §3.1). An entry becomes
`adopt-relink` when its digest matches either (a) an `adopt-copy` earlier in
the same plan, or (b) an **existing source skill of the same name** — case
(b) is what makes the two-run sequence work, and it is a narrow, safe
exception to §3.2's collision refusal: identical bytes, so nothing can be
lost. Non-identical same-name entries stay blocked as `name-collision`.
Apply for `adopt-relink` skips the copy phase entirely: index, quarantine,
symlink.

It must not justify UI complexity: no separate "batch" dialog, just one row
in the same preview reading *"same content as `<name>` — will be linked, not
copied"*.

Evidence caveat, stated so the maintainer can weigh it: §2.5 found **zero**
cross-target pairs of directory entries with identical real content on the
machine that has 182 unmanaged entries. Every apparent duplicate is a symlink
fan-out from a generator (§2.3) or a link farm (§2.4), both blocked anyway.
So this is required for *correctness of the state machine*, not because the
case is common here.

Rejected: adopt strictly per entry, ignoring digests — the dead end above.
Also rejected: a separate "convert duplicates" batch action; it splits one
decision across two dialogs.

### 3.5 Unmanaged symlinks

**Recommendation: v1 refuses, with `adopt-blocked: unmanaged-symlink` and a
diagnostic naming the resolved link target.** Confirmed, and the inventory
raises it from "reasonable scoping" to "the only correct answer":

- 152 of 182 entries (84%) are symlinks;
- 96 point into a **Nix-managed generator tree** — adopting them forks
  content from its generator, and the next rebuild recreates the link,
  silently reverting the adoption;
- 73 are **broken**, so there is no link target to adopt;
- 2 point at *another runtime target*, so "adopt the link target" would
  recurse into a different unmanaged entry.

The diagnostic is the product here. Naming the destination turns a mute
"symlink" pill into an explanation ("this is generated by another tool" /
"this points nowhere"), and the broken ones want a *different* action
entirely — "remove this dead link" — which is deletion of an
ai-usage-recognisable dead symlink, and therefore a separate decision, not
a silent extension of adoption. Record as follow-up; do not fold it in.

Rejected: adopt the link target's content. Beyond the above, it would break
the invariant that adoption only ever writes bytes the user already has
inside the runtime target — the link target is somewhere else entirely, and
may be in a repository with its own history.

### 3.6 Source-repo dirtiness

**Recommendation: out of scope. Document, do not enforce.** Confirmed.
`packages/skills` has no git dependency and should not acquire one — its
whole contract is "pure filesystem" (plan 083 out-of-scope list). Adoption
writes a new directory under `<source>/skills/<name>`; the user reviews it
with their own VCS.

Two concrete obligations follow, both cheap:

1. The preview must state the exact destination path per entry so the user
   knows what will appear in their working tree.
2. The success message names the quarantine path, so the user can diff
   adopted-vs-original before committing.

Rejected: requiring a clean tree. It would make the feature unusable
mid-work for exactly the user who is consolidating, and the safety it buys
is already provided by "the original is never deleted".

### 3.7 API shape

**Recommendation:** mirror `previewReconcileAll`/`reconcileAll` exactly.

Domain (`packages/skills`):

```ts
// One coordinate covers both entry points (§3.8). A system target is a
// SkillTarget id; a project target is a (projectPath, runtimeDirId) pair from
// `projectSkillDirectories` (contracts.ts:288).
export type AdoptTargetRef =
  | { kind: 'system'; targetId: string }
  | { kind: 'project'; projectPath: string; runtimeDirId: string };

export interface AdoptEntryRef { entryName: string; target: AdoptTargetRef }

export type AdoptBlockedReason =
  | 'cross-device-quarantine'
  | 'entry-too-large'
  | 'invalid-skill-content'
  | 'name-collision'
  | 'nested-skill-collection'
  | 'nested-symlink-payload'
  | 'not-a-skill'
  | 'not-project-owned'        // project placement is not 'owned-directory'
  | 'quarantine-occupied'
  | 'reserved-entry-name'
  | 'unmanaged-symlink';

export type AdoptAction =
  | {
      contentDigest: string;      // sha256 over sorted (relpath, mode, bytes)
      entryIdentity: { dev: string; ino: string };
      entryName: string;
      entryPath: string;
      fileCount: number;
      quarantinePath: string;
      skillName: string;          // === entryName in v1; explicit for later rename
      sourceIdentity: ProjectionTargetIdentity;   // of <source>/skills
      sourcePath: string;
      target: AdoptTargetRef;
      targetIdentity: ProjectionTargetIdentity;
      totalBytes: number;
      type: 'adopt-copy';
    }
  | {
      contentDigest: string;
      entryIdentity: { dev: string; ino: string };
      entryName: string;
      entryPath: string;
      linkedToSkillName: string;  // adopted by an 'adopt-copy' in the same plan,
                                  // or already present in the source repo
      quarantinePath: string;
      sourceIdentity: ProjectionTargetIdentity;
      sourcePath: string;
      target: AdoptTargetRef;
      targetIdentity: ProjectionTargetIdentity;
      type: 'adopt-relink';
    }
  | {
      entryName: string;
      entryPath: string;
      reason: AdoptBlockedReason;
      detail?: string;            // e.g. the resolved symlink destination
      target: AdoptTargetRef;
      type: 'adopt-blocked';
    };

export interface AdoptPlan { actions: readonly AdoptAction[]; snapshot: SkillManagementSnapshot }

export type AdoptOutcome =
  | { entryName: string; quarantinePath: string; skillName: string; target: AdoptTargetRef;
      type: 'adopted' | 'relinked' }
  | { entryName: string; reason: AdoptBlockedReason; target: AdoptTargetRef; type: 'blocked' }
  | { entryName: string; message: string; phase: 'copied' | 'linked' | 'planned' | 'quarantining';
      recoverable: boolean; target: AdoptTargetRef; type: 'failed' };

export interface AdoptResult { outcomes: readonly AdoptOutcome[]; snapshot: SkillManagementSnapshot }

export const planAdoptEntries: (input: LoadSkillManagementSnapshotInput & {
  entries: readonly AdoptEntryRef[];
}) => Promise<AdoptPlan>;              // reads the filesystem, mutates nothing

export const applyAdoptPlan: (input: LoadSkillManagementSnapshotInput & {
  plan: AdoptPlan;
}) => Promise<AdoptResult>;            // locked, revalidated, journalled
```

`planAdoptEntries` is *not* pure — it must hash file contents and stat the
tree. Keep the pure part (classification given an already-read tree
description) separately testable; that is where the §3.3 block table lives
and where the crash-free unit tests belong.

**Lock protocol extension — the source side.** Plan 083's STOP condition
says: *"`withSkillProjectionLock` / `targetIdentity` revalidation cannot
cover the source-repo side of the write — the lock protocol may need a design
extension; report rather than writing unlocked."* It cannot, and here is the
extension.

Reconcile only ever writes *into a target*, keyed by that target's canonical
path, so one lock suffices. Adoption writes into **two** namespaces: the
target (a symlink replaces an entry) and `<source>/skills` (a new directory
appears). Two adoptions of the same name from two different targets take two
*different* target locks and would race on the same source destination —
and nothing today pins the source repo's identity between preview and apply,
so a source repo moved or re-pointed in `config.skills.sourceRepoPath` in
between would be written through blindly.

The extension needs no new primitive; `withSkillProjectionLock` already
accepts an arbitrary identity string:

- `AdoptAction` carries `sourceIdentity: ProjectionTargetIdentity` for
  `<source>/skills`, captured by the planner exactly as `targetIdentity` is
  captured in `scanTargetProjections` (`projections.ts:220–229`).
- `applyAdoptPlan` takes **two nested locks in a fixed order — source outer,
  target inner** — so every adoption serialises on the shared source
  namespace and deadlock is impossible (a total order over lock identities).
  Reconcile is unaffected: it never takes the source lock, and it never
  writes into the source, so the two protocols cannot deadlock against each
  other either.
- Under the source lock, re-`lstat` `<source>/skills` and compare `dev`,
  `ino`, and `realpath` against `action.sourceIdentity`. A mismatch means the
  source repo moved → `failed`, nothing written.
- The source lock's `privateStatePath` is the same
  `~/.config/ai-usage`, so both locks live in one
  `skills-projection-locks/` directory keyed by digest — no layout change.

**First adoption into a repo with no `skills/` directory.**
`scanSkillSourceRepository` deliberately returns an empty inventory when
`<source>/skills` is missing (`source-scan.ts:397–400`), so this is the
*normal* first-run state, not an error — and a missing directory has no
`dev`/`ino` to pin. The existing primitive already solves it:
`projectionLockIdentityForTarget` (`projection-lock.ts:20–42`) walks up to
the nearest existing non-symlink ancestor and returns a canonical path for a
path that need not exist. So:

- the source **lock identity** is always
  `projectionLockIdentityForTarget(<source>/skills)`, existing or not;
- when `<source>/skills` is missing, `sourceIdentity` pins the nearest
  existing ancestor instead, and the plan carries
  `sourceSkillsMissing: true`;
- under the source lock, apply creates `<source>/skills` with the same
  ancestor-verified, non-symlink, component-by-component walk
  `createSkillTargetDirectory` already implements (`workflows.ts:249–305`),
  then re-`lstat`s it before proceeding.

No new primitive; the first adoption is not a special case in the UI.

**Apply-side revalidation** — the whole trust argument, and stricter than
reconcile because adoption writes into a directory ai-usage does not own:

1. Take `withSkillProjectionLock(privateStatePath, sourceIdentity.canonicalPath, …)`
   (outer), then `withSkillProjectionLock(privateStatePath, targetIdentity.canonicalPath, …)`
   (inner).
2. Re-`lstat` the target directory; compare `dev`, `ino`, and `realpath`
   against `action.targetIdentity` — identical to `applyProjectionAction`
   (`projections.ts:460–470`). Re-`lstat` `<source>/skills` and compare
   against `action.sourceIdentity`.
3. Re-`lstat` the **entry itself**; compare against `action.entryIdentity`.
   This is new: reconcile only pins the target directory, because it only
   ever creates or replaces links it owns. Adoption reads and then vacates a
   directory whose bytes belong to the user, so the entry's own identity
   must be pinned too. `UnmanagedEntry` does not carry an entry identity
   today (`contracts.ts:131–139` has only `targetIdentity`), so `AdoptAction`
   carries it and the planner captures it.
4. Re-verify the content digest before the quarantine rename. A mismatch
   between plan and apply means the user edited the entry in between →
   `failed` with `recoverable: true`, nothing moved.
5. Re-verify the content digest **again, after the quarantine rename**, and
   compare it against the digest the copy in `copied` was made from. Step 4
   alone does not close the window: it reads the entry while that entry is
   still at its original path and still writable, so a writer can change it
   between that read and the rename completing. Publishing the symlink then
   points the user at a copy that silently dropped their edit. The rename is
   the claim — after it, the original is unreachable and its digest is
   finally stable, which is the only point at which the comparison proves
   anything.

   On divergence: do **not** create the symlink. Rename the quarantined
   entry back to its original path, discard the candidate copy, and return
   `adopt-conflict: entry-changed-during-adoption` with
   `recoverable: true` so the caller can re-run against the new content.
   The invariant this buys: a concurrent mutation is never lost and is never
   temporarily replaced by a stale copy.
6. The destination `<source>/skills/<name>` must not exist at rename time
   (the atomic-rename precondition doubles as a late collision check).

**Apply re-derives the plan; the client's plan is a confirmation token, not
an instruction.** This is the part that makes steps 1–5 mean anything.
Comparing payload-supplied paths against payload-supplied identities proves
nothing on its own — a stale plan whose `sourcePath` points at an
*abandoned but still-present* source repo would satisfy every identity check
and write to the wrong repository. Reconcile already avoids this: `reconcileAll`
does not consume `previewReconcileAll`'s actions, it calls
`applyPlannedActions`, which re-plans from a freshly loaded snapshot
(`workflows.ts:210,234–239`). Adoption must do the same:

- `applyAdoptPlan` receives **entry refs plus a plan fingerprint**, not the
  plan's derived coordinates.
- Under both locks it re-runs `planAdoptEntries` from current config and a
  fresh snapshot, deriving `sourcePath`, `quarantinePath`, every identity,
  and every classification itself.
- If the re-derived plan's fingerprint differs from the confirmed one, it
  returns `SkillsConflict` (409 — already defined at
  `apps/web/src/lib/server/rpc/skills.ts:88–94`) and the UI re-opens the
  preview showing what changed. Nothing is written.

This dissolves the concurrent-duplicate race by construction. Two users (or
tabs) previewing the same name from two targets both see `adopt-copy`; the
source lock serialises them; the second one's re-plan observes the now-
existing destination and reclassifies it as `adopt-relink` (identical
digest) or `name-collision` (divergent) — so the fingerprint changes, the
confirm is refused with `SkillsConflict`, and the user re-confirms against
the true state. No double copy, and no silent substitution of one action for
another.

Web contract (`packages/web-contract/src/skills.ts`):

```
adoptPreview: POST /skills/adopt/preview  input: adoptEntriesInputSchema     output: adoptPlanSchema
adoptApply:   POST /skills/adopt          input: adoptConfirmationSchema     output: adoptResultSchema
```

with `skillsProcedureIntents.adoptPreview = 'query'`,
`adoptApply = 'mutation'`. POST-with-query-intent already has precedent:
`managedMarkdown` is `POST /skills/markdown/read` typed `'query'`.
`adoptEntriesInputSchema` reuses `discoveredEntryNameSchema` (**not**
`skillNameSchema` — §2.6); its `AdoptTargetRef` arm reuses `targetIdSchema`
for `'system'` and `projectPathSchema` (`skills.ts:72`) plus a
`picklist(projectSkillDirectories.map(d => d.id))` for `'project'`. Bounded
to `MAX_COLLECTION_ITEMS`. `adoptConfirmationSchema` is
`{ entries: AdoptEntryRef[]; planFingerprint: sha256Schema }` — small,
bounded, and carrying no server-derived path at all. `adoptPlanSchema` gets
its own byte budget beside `MAX_RECONCILE_BYTES`.

Rejected: echoing the whole `AdoptPlan` back to `adoptApply`. It puts
server-derived paths on the wire in the inbound direction, which is a
validation seam that buys nothing once apply re-plans anyway.

Rejected: a single `adoptEntries(refs)` mutation with no preview. It would
put a destructive-looking operation one click from a list, and the whole
value of the reconcile pattern is that refusals are visible *before* the
mutation.

### 3.8 UI entry points

Both dead-ends open the **same preview dialog**; only the seed set differs.

1. **Consolidate panel** (`skills-consolidate.svelte:80`) — the per-entry
   button changes from `Review consolidation` (which calls
   `reviewConsolidation` = `goto('/skills/matrix')`,
   `skills-health-slot.svelte:369–371`, identical for all 182 rows and
   carrying no entry identity) to **`Adopt…`**, seeded with that one
   `(targetId, entryName)`. The group `<summary>` gains **`Adopt all
   adoptable…`**, seeded with the group's entries; the count in that button
   must be the *adoptable* count, not the entry count, or the panel is
   promising 64 adoptions where 3 are possible.
2. **Project-skill Actions panel** (`skills-health-slot.svelte:593–597`,
   "Read-only runtime observation.", matching
   `docs/skills-management-spec.md:42`) — gains the same `Adopt…` for the
   observed entry, **in v1**. This is resolved, not deferred: the coordinate
   is `AdoptTargetRef` (§3.7), whose `'project'` arm is
   `(projectPath, runtimeDirId)` — both already present on every
   `ProjectSkillObservation` (`contracts.ts:295–307`), and `runtimeDirId` is
   already constrained to the `projectSkillDirectories` registry
   (`contracts.ts:288–291`). The entry directory is
   `path.join(projectPath, relativePath, name)`, and `projectPath` is already
   authorised against the allow-list in `readProjectMarkdown`
   (`application.ts:164–167`) — adoption reuses that same check verbatim.

   Only `placement === 'owned-directory'` is adoptable; `symlink-to-source`
   is already managed, and `project-symlink` / `external-symlink` block as
   `not-project-owned` (the project-scope analogue of §3.5). After a
   successful adoption the observation's placement becomes
   `symlink-to-source` on the next scan, which is the acceptance signal.

   Quarantine for a project target follows the same rule as §3.1 — the
   *parent* of the runtime dir, i.e. `<projectPath>/.claude/.ai-usage-skill-quarantine/`
   — so it stays out of `.claude/skills` and out of the scan. It does land
   inside the user's project repository, so the preview must name that path
   explicitly and the follow-up list should carry a `.gitignore` hint.

Dialog states:

```
[Preview]  <n> entries selected
  ✓ <name>        copy   4 files, 44 KB   →  <source>/skills/<name>
  ✓ <name>        same content as <name> — will be linked, not copied
  ✗ <name>        blocked: points at ~/…/<upstream>/… (managed by another tool)
  ✗ .system       blocked: not a skill (no SKILL.md; contains nested skills)
  ✗ <name>        blocked: a source skill already has this name
  ── Originals are moved to ~/.claude/.ai-usage-skill-quarantine/ and never deleted.
  [Cancel]  [Adopt <k> entries]

[Result]  per-entry outcome reusing the reconcile result presentation
  ✓ adopted   <name>   original kept at <quarantine path>
  ✗ failed    <name>   entry changed since preview — nothing was moved
```

Non-negotiable copy rules: the blocked list is shown **before** the confirm
button, never collapsed; the quarantine sentence is in the dialog, not a
tooltip; and the existing panel promise *"Nothing is ever deleted
automatically"* (`skills-consolidate.svelte:56–57`) stays literally true —
the quarantined original is never removed by the tool, and no UI in v1
removes it either.

---

## 4. What Phase B must test

Beyond plan 083's listed crash windows:

1. **Crash between `copied` and `quarantined`** → re-run adopts cleanly;
   source copy is reused, not duplicated.
2. **Crash between `quarantined` and `linked`** → re-run restores the
   symlink; the quarantined original is still present and byte-identical.
3. **Digest drift between plan and apply** → `failed`, and the runtime entry
   is untouched (assert `dev`/`ino` unchanged).
4. **Entry identity swapped between plan and apply** (replace the directory
   with a symlink) → refused, no write.
5. **Link-farm directory** → `nested-symlink-payload`, no bytes copied.
6. **Nested skill collection / dot-prefixed name** → blocked, and — the
   regression that matters — the *planner does not throw*; the other
   entries in the same plan still produce actions.
7. **Quarantine leaf already exists** → `quarantine-occupied`, no write.
7a. **Quarantine root is a symlink** pointing outside the projection root
    (adversarial: the whole point of `lstat`) → `quarantine-root-unsafe`
    naming the link target, nothing created at the link's destination, and
    the runtime entry still present and byte-identical. A second case with
    the root existing as a **regular file** → same refusal, different
    reported type. Both must fail *before* any `mkdir` or rename, and the
    symlink itself must be left in place.
7b. **Entry mutated between the pre-rename digest and the rename** (write a
    child file from the injected `rename` stub, so the change lands inside
    the window step 4 cannot see) → the symlink is **not** created, the
    entry is back at its original path, its content is the *mutated*
    content rather than the copy, and the outcome is
    `entry-changed-during-adoption`. This is the test that distinguishes
    the post-quarantine re-digest from the pre-rename one: with step 5
    removed it must fail, and a stale copy would be published in its place.
8. **`EXDEV` on the quarantine rename** (inject via a stubbed `rename`) →
   `cross-device-quarantine`, no copy-then-delete fallback.
9. **Concurrent adopt of two entries in the same target** → serialised by
   the inner target lock; both succeed or one fails cleanly.
10. **Concurrent adopt of the same name from two different targets** →
    serialised by the **source** lock; the second's re-plan reclassifies to
    `adopt-relink` (identical digest) or `name-collision` (divergent), the
    fingerprint changes, and the confirm returns `SkillsConflict`. Never a
    double copy, never a silently substituted action.
11. **`sourceRepoPath` re-pointed between preview and apply, old directory
    still present** → the re-plan derives the new path, the fingerprint
    differs, `SkillsConflict`; nothing is written to either repository.
    (Identity comparison alone would pass here — this is the test that
    proves apply re-derives rather than trusts the payload.)
12. **Crash mid-copy** → the `<source>/.ai-usage-adopt/<opId>/` staging tree
    is removed by recovery and the re-run succeeds; `<source>/skills` never
    saw a partial tree.
13. **Crash between the index write and the quarantine rename** → recovery
    drops the orphan index entry and the original is still at `entryPath`;
    `lstat(quarantinePath)` is `ENOENT`, proving no leaf was reserved.
14. **First adoption into a source repo with no `skills/` directory** →
    the lock identity resolves through the nearest existing ancestor,
    `skills/` is created under the lock, adoption completes.
15. **Project-scope adoption** of an `owned-directory` observation → the
    observation's `placement` becomes `symlink-to-source` on rescan; a
    `project-symlink` observation blocks as `not-project-owned`.

The package's temp-home harness (see `snapshot.test.ts`, `projection.test.ts`)
supports all of these; `applyProjectionAction`'s `hooks.afterClaim`
(`projections.ts:444`) is the established way to inject a crash between
phases and should be mirrored as `hooks.afterCopy` / `hooks.afterQuarantine`.

---

## 5. Recommendation summary

| # | Question | Recommendation |
|---|---|---|
| 1 | Move or copy | Copy → verify → quarantine-rename → symlink; journalled, 4 phases, all re-runnable; quarantine in the target's **parent**, refuse on `EXDEV` |
| 2 | Name collisions | Refuse (`name-collision`) — and note it arrives via the `Projection` channel, not `UnmanagedEntry` |
| 3 | Validation gate | Validate first; refuse `invalid`, allow `warning`; plus four new structural refusals from the inventory. Whole-entry byte-exact copy (§3.3a), with a `SKILL.md`-only alternative offered explicitly |
| 4 | Identical duplicates | `adopt-relink` **required in v1** — without it the second target's identical entry is a permanent dead end |
| 5 | Unmanaged symlinks | Refuse (`unmanaged-symlink`) with the destination named; 84% of the backlog, mostly generator-owned or broken |
| 6 | Source dirtiness | Out of scope; document destination and quarantine paths instead |
| 7 | API shape | `planAdoptEntries` / `applyAdoptPlan`; apply **re-derives** the plan under **two nested locks — source outer, target inner** and refuses on fingerprint drift (`SkillsConflict`); target, entry and source identity all revalidated; `POST /skills/adopt/preview` + `POST /skills/adopt` |
| 8 | UI | Both dead-ends open one preview dialog keyed by `AdoptTargetRef` + `entryName`, project scope included in v1; blocked rows shown before confirm |

**Overall recommendation to the maintainer: approve Phase B, but split it.**

- **B0 (small, independent, recommended even if adoption is deferred):**
  classify `not-a-skill` / `reserved-entry-name` / `unmanaged-symlink`
  destinations in the consolidate panel so the 182-item backlog stops
  including a Codex-internal directory and 73 dead links, and so each row
  says *why* it is there. This is the honesty fix; adoption is the exit.
- **B1:** the domain protocol + tests (§4). The risk is concentrated here.
- **B2:** contract/RPC + the one preview dialog wired to both dead-ends.

Effort with the inventory in hand: B0 S, B1 M–L, B2 M. Plan 083's original
L estimate holds for B1+B2.

---

## 6. Where this design is uncertain

- **Adoptable yield.** On this machine, of 182 entries roughly 23 are
  adoptable (single/multi-file `SKILL.md` directories), 6 are link farms, 1
  is `.system`, 152 are symlinks. So adoption plausibly clears ~13% of the
  visible backlog and B0 explains the rest. *Evidence that would settle
  whether that is representative:* the same inventory script run against a
  second machine — particularly one that does not use a Nix generator for
  skills. If copies dominate elsewhere, §3.4's batch path matters more than
  it does here.
- **Project-scope quarantine placement.** §3.8 resolves the *coordinate*
  (`AdoptTargetRef`), but the project quarantine lands inside the user's
  project repository. Whether that is acceptable, or whether project-scope
  originals should instead go to `~/.config/ai-usage/` (accepting the `EXDEV`
  risk of §3.1), is a judgement call the maintainer should make. *Evidence
  that would settle it:* whether any configured `projectPaths` entry is on a
  different filesystem from `$HOME` — zero project paths are configured on
  this machine, so there is nothing to measure yet.
- **The mode-preservation budget.** No executable file was observed, so
  "preserve mode bits" is currently untested against a real case. It should
  still be implemented (the copy is byte-and-mode exact), but a test needs a
  synthetic fixture rather than real data.
- **Dead-link removal** is the natural sibling of §3.5 and would clear 73
  entries in one action — but it is *deletion*, and this plan's whole
  premise is that ai-usage does not delete. It needs its own decision.

## 7. Follow-ups to record

- Skill **creation** from scratch reuses `applyAdoptPlan`'s "write into
  source repo, then project" primitive (anticipated by plan 006). Keep the
  copy-and-project step callable without an entry source.
- **Compare-and-merge** for `name-collision` (§3.2) — 5 real instances.
- **Dead unmanaged-symlink removal** (§3.5, §6) — 73 real instances.
- `docs/skills-management-spec.md:42` ("Read-only runtime observation")
  needs updating when §3.8's second entry point ships.
- Project-scope adoption writes `.ai-usage-skill-quarantine/` into the user's
  project repository (§3.8, §6) — the build plan should surface a
  `.gitignore` hint in the result message.
