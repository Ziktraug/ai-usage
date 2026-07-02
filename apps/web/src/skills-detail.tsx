import { css, cx } from '@ai-usage/design-system/css';
import {
  commandButton,
  ghostButton,
  HarnessBadge,
  meta,
  muted,
  panel,
  panelHeader,
  panelHeaderRow,
  panelSub,
  panelTitle,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import type { ProjectSkillInventory, SkillDiagnostic, SkillManagementSnapshot, SourceSkill } from '@ai-usage/skills';
import { createEffect, createMemo, createResource, createSignal, For, type JSX, Show } from 'solid-js';
import { type ProjectRuntimeDirId, projectSkillDirectories } from './project-skill-directories';
import { getManagedSkillMarkdown, getProjectSkillMarkdown, saveManagedSkillMarkdown } from './server/skills';
import {
  buildGlobalSkillExposure,
  buildProjectSkillRows,
  buildSkillHealthSummary,
  count,
  findGlobalSkill,
  findProjectSkillRow,
  globalSkillAttentionCount,
  type ProjectSkillRow,
  type SkillSelection,
  type SkillTreeModel,
  selectionKey,
  skillInvocation,
  skillScopeMatches,
} from './skills-page-model';
import type { ProjectInventoriesResult } from './skills-workspace';

type SkillMarkdownResult =
  | { ok: true; data: { content: string; path: string; sha256: string; skillName: string } }
  | { ok: false; error: { message: string; tag: string } };

type SkillMarkdownSaveResult =
  | {
      ok: true;
      data: {
        document?: { content: string; path: string; sha256: string; skillName: string };
        reason?: 'conflict' | 'not-found' | 'too-large';
        snapshot?: SkillManagementSnapshot;
      };
    }
  | { ok: false; error: { message: string; tag: string } };

type ProjectSkillMarkdownResult =
  | { ok: true; data: { content: string; path: string; skillName: string; truncated: boolean } }
  | { ok: false; error: { message: string; tag: string } };

const detailStack = css({
  display: 'grid',
  gap: '14px',
  minW: 0,
});

const hero = css({
  display: 'grid',
  gap: '8px',
});

const titleRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 10px',
  alignItems: 'center',
});

const skillTitle = css({
  fontSize: { base: '22px', md: '28px' },
  fontWeight: 750,
  overflowWrap: 'anywhere',
});

const metadataGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
  gap: '10px',
});

const metadataItem = css({
  display: 'grid',
  gap: '3px',
  p: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  minW: 0,
});

const metadataLabel = css({
  color: 'muted',
  fontSize: '11px',
  fontWeight: 650,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
});

const wrapValue = css({
  overflowWrap: 'anywhere',
});

const section = css({
  display: 'grid',
  gap: '10px',
});

const exposureRow = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'auto minmax(0, 1fr) auto' },
  gap: '8px 10px',
  alignItems: 'start',
  p: '10px 0',
  borderTop: '1px solid token(colors.line)',
});

const pathText = css({
  fontFamily: 'mono',
  fontSize: '12px',
  color: 'muted',
  overflowWrap: 'anywhere',
});

const editorBlock = css({
  maxH: '460px',
  overflow: 'auto',
  p: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  fontFamily: 'mono',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
});

const editorArea = css({
  minH: '360px',
  w: '100%',
  p: '10px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontFamily: 'mono',
  fontSize: '12px',
  resize: 'vertical',
});

const runtimeSelect = css({
  h: '34px',
  maxW: '240px',
  px: '8px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '13px',
});

const actionRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
});

const chipRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  alignItems: 'center',
});

const chipButton = css({
  appearance: 'none',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'ink',
  cursor: 'pointer',
  fontSize: '12px',
  px: '8px',
  py: '4px',
  _hover: {
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const busyButton = css({
  '&[data-pending=true]': {
    _after: {
      content: '" ..."',
      color: 'accent',
    },
  },
});

const diagnosticRow = css({
  display: 'grid',
  gap: '3px',
  p: '8px 0',
  borderTop: '1px solid token(colors.line)',
});

const compactList = css({
  display: 'grid',
  gap: '8px',
});

const compactRow = css({
  appearance: 'none',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'center',
  p: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'ink',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: {
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const stateOk = css({ color: 'status.ok' });
const stateWarn = css({ color: 'status.warn' });
const stateDanger = css({ color: 'status.danger' });

const runtimeLabels = new Map(projectSkillDirectories.map((directory) => [directory.id, directory.label]));

const validationPillClass = (status: string) => {
  if (status === 'invalid') {
    return statusPillDanger;
  }
  if (status === 'warning') {
    return statusPillWarn;
  }
  return statusPillOk;
};

const diagnosticPillClass = (diagnostic: SkillDiagnostic) => {
  if (diagnostic.severity === 'error') {
    return statusPillDanger;
  }
  if (diagnostic.severity === 'warning') {
    return statusPillWarn;
  }
  return statusPillInfo;
};

const exposureStateClass = (state: string) => {
  if (state === 'linked' || state === 'symlink-to-source' || state === 'owned-directory') {
    return stateOk;
  }
  if (state === 'missing') {
    return stateWarn;
  }
  if (state === 'broken-link' || state === 'wrong-target' || state === 'missing-target') {
    return stateDanger;
  }
  return muted;
};

const projectPlacementLabel = (placement: string) => {
  if (placement === 'symlink-to-source') {
    return 'Global skill exposed here';
  }
  if (placement === 'external-symlink') {
    return 'External symlink';
  }
  return 'Owned project skill';
};

const MetadataItem = (props: { label: string; value: JSX.Element }) => (
  <div class={metadataItem}>
    <span class={metadataLabel}>{props.label}</span>
    <span class={wrapValue}>{props.value}</span>
  </div>
);

const MarkdownPreview = (props: { content: string }) => <pre class={editorBlock}>{props.content}</pre>;

export const SkillsDetail = (props: {
  configurationPanel: () => JSX.Element;
  consolidatePanel: () => JSX.Element;
  onSelect: (selection: SkillSelection) => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  pendingOperation: string | null;
  projectInventories: ProjectInventoriesResult | undefined;
  projectInventoriesLoading: boolean;
  reconcileSkill: (skillName: string) => void;
  selection: SkillSelection;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
  tree: SkillTreeModel;
}) => {
  const inventories = createMemo(() => (props.projectInventories?.ok ? props.projectInventories.data : []));
  const selectedGlobalSkill = createMemo(() =>
    props.selection.type === 'global-skill' ? findGlobalSkill(props.snapshot, props.selection.skillName) : undefined,
  );
  const selectedProjectInventory = createMemo(() => {
    const selection = props.selection;
    return selection.type === 'project-scope' || selection.type === 'project-skill'
      ? inventories().find((inventory) => inventory.projectPath === selection.projectPath)
      : undefined;
  });
  const selectedProjectSkill = createMemo(() =>
    props.selection.type === 'project-skill'
      ? findProjectSkillRow(inventories(), props.selection.projectPath, props.selection.skillName)
      : undefined,
  );

  return (
    <section aria-label="Skill detail" class={cx(panel, detailStack)}>
      <Show when={props.selection.type === 'global-scope'}>
        <GlobalScopeDetail
          configurationPanel={props.configurationPanel}
          consolidatePanel={props.consolidatePanel}
          onSelect={props.onSelect}
          snapshot={props.snapshot}
        />
      </Show>
      <Show when={selectedGlobalSkill()}>
        {(skill) => (
          <GlobalSkillDetail
            onSelect={props.onSelect}
            onSnapshot={props.onSnapshot}
            pendingOperation={props.pendingOperation}
            reconcileSkill={props.reconcileSkill}
            skill={skill()}
            snapshot={props.snapshot}
            toggleSkill={props.toggleSkill}
            tree={props.tree}
          />
        )}
      </Show>
      <Show when={props.selection.type === 'project-scope'}>
        <ProjectScopeDetail
          inventory={selectedProjectInventory()}
          loading={props.projectInventoriesLoading}
          onSelect={props.onSelect}
          projectPath={props.selection.type === 'project-scope' ? props.selection.projectPath : ''}
        />
      </Show>
      <Show when={selectedProjectSkill()}>
        {(row) => (
          <ProjectSkillDetail
            onSelect={props.onSelect}
            projectPath={props.selection.type === 'project-skill' ? props.selection.projectPath : ''}
            row={row()}
            tree={props.tree}
          />
        )}
      </Show>
    </section>
  );
};

const GlobalScopeDetail = (props: {
  configurationPanel: () => JSX.Element;
  consolidatePanel: () => JSX.Element;
  onSelect: (selection: SkillSelection) => void;
  snapshot: SkillManagementSnapshot;
}) => {
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const attentionSkills = createMemo(() =>
    props.snapshot.skills
      .map((skill) => ({ attentionCount: globalSkillAttentionCount(props.snapshot, skill), skill }))
      .filter((entry) => entry.attentionCount > 0 || entry.skill.validationStatus !== 'valid' || !entry.skill.enabled)
      .sort((left, right) => {
        if (left.attentionCount !== right.attentionCount) {
          return right.attentionCount - left.attentionCount;
        }
        return left.skill.name.localeCompare(right.skill.name);
      })
      .map((entry) => entry.skill)
      .slice(0, 6),
  );
  return (
    <div class={detailStack}>
      <div class={hero}>
        <div class={titleRow}>
          <h2 class={skillTitle}>Global skills</h2>
          <span class={cx(statusPill, statusPillInfo)}>{count(props.snapshot.skills.length, 'skill')}</span>
        </div>
        <p class={muted}>
          Shared source skills managed from {props.snapshot.config.sourceRepoPath ?? 'an unconfigured source'}.
        </p>
      </div>
      <div class={metadataGrid}>
        <MetadataItem label="Healthy links" value={`${health().healthyLinkCount}/${health().expectedLinkCount}`} />
        <MetadataItem label="To repair" value={String(health().toRepairCount)} />
        <MetadataItem label="Blocked" value={String(health().blockedCount)} />
        <MetadataItem
          label="To consolidate"
          value={`${health().consolidateCopies} copies / ${health().consolidateSymlinks} symlinks`}
        />
      </div>
      <section class={section}>
        <div class={panelHeader}>
          <h3 class={panelTitle}>Needs attention</h3>
          <p class={panelSub}>Invalid or disabled skills show here first.</p>
        </div>
        <Show fallback={<p class={meta}>No disabled or invalid skills.</p>} when={attentionSkills().length > 0}>
          <div class={compactList}>
            <For each={attentionSkills()}>
              {(skill) => (
                <button
                  class={compactRow}
                  onClick={() => props.onSelect({ skillName: skill.name, type: 'global-skill' })}
                  type="button"
                >
                  <span>
                    <span class={strongCell}>{skill.name}</span>
                    <span class={meta}> {skill.description || 'No description'}</span>
                  </span>
                  <span class={cx(statusPill, validationPillClass(skill.validationStatus))}>
                    {skill.enabled ? skill.validationStatus : 'disabled'}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </section>
      {props.consolidatePanel()}
      {props.configurationPanel()}
    </div>
  );
};

const GlobalSkillDetail = (props: {
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  onSelect: (selection: SkillSelection) => void;
  pendingOperation: string | null;
  reconcileSkill: (skillName: string) => void;
  skill: SourceSkill;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
  tree: SkillTreeModel;
}) => {
  const exposure = createMemo(() => buildGlobalSkillExposure(props.snapshot, props.skill.name));
  const duplicateMatches = createMemo(() =>
    skillScopeMatches(
      props.tree,
      props.skill.name,
      selectionKey({ skillName: props.skill.name, type: 'global-skill' }),
    ),
  );
  return (
    <div class={detailStack}>
      <div class={hero}>
        <div class={titleRow}>
          <h2 class={skillTitle}>{props.skill.name}</h2>
          <span class={cx(statusPill, validationPillClass(props.skill.validationStatus))}>
            {props.skill.validationStatus}
          </span>
          <span class={cx(statusPill, statusPillInfo)}>
            {skillInvocation(props.skill) === 'auto' ? 'Auto' : 'Manual'}
          </span>
          <span class={cx(statusPill, props.skill.enabled ? statusPillOk : statusPillWarn)}>
            {props.skill.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <p class={muted}>{props.skill.description || 'No description'}</p>
        <DuplicateSkillLinks matches={duplicateMatches()} onSelect={props.onSelect} />
      </div>
      <div class={metadataGrid}>
        <MetadataItem label="Source path" value={props.skill.path} />
        <MetadataItem label="SKILL.md" value={props.skill.skillMdPath} />
        <MetadataItem label="Invocation" value={skillInvocation(props.skill) === 'auto' ? 'Auto' : 'Manual'} />
        <MetadataItem
          label="Tokens"
          value={props.skill.tokenCount ? `${props.skill.tokenCount.total} tok` : 'Unknown'}
        />
      </div>
      <section class={section}>
        <div class={panelHeaderRow}>
          <div>
            <h3 class={panelTitle}>Runtime exposure</h3>
            <p class={panelSub}>Where this source skill is linked or blocked.</p>
          </div>
          <button
            aria-busy={props.pendingOperation === `toggle:${props.skill.name}` ? 'true' : undefined}
            class={cx(ghostButton, busyButton)}
            data-pending={props.pendingOperation === `toggle:${props.skill.name}` ? 'true' : undefined}
            disabled={props.pendingOperation !== null}
            onClick={() => props.toggleSkill(props.skill.name, !props.skill.enabled)}
            type="button"
          >
            {props.skill.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
        <For each={exposure()}>
          {(entry) => {
            const target = () => props.snapshot.targets.find((item) => item.id === entry.targetId);
            return (
              <div class={exposureRow}>
                <HarnessBadge name={target()?.label ?? entry.targetId} />
                <div>
                  <div class={cx(strongCell, exposureStateClass(entry.state))}>{entry.label}</div>
                  <div class={pathText}>{entry.expectedPath}</div>
                  <Show when={entry.actualPath}>
                    {(actualPath) => <div class={pathText}>Actual: {actualPath()}</div>}
                  </Show>
                </div>
                <Show when={entry.canReconcile}>
                  <button
                    aria-busy={props.pendingOperation === `reconcile:${props.skill.name}` ? 'true' : undefined}
                    class={cx(ghostButton, busyButton)}
                    data-pending={props.pendingOperation === `reconcile:${props.skill.name}` ? 'true' : undefined}
                    disabled={props.pendingOperation !== null}
                    onClick={() => props.reconcileSkill(props.skill.name)}
                    type="button"
                  >
                    Reconcile
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
      </section>
      <SkillMarkdownEditor onSnapshot={props.onSnapshot} skillName={props.skill.name} />
      <Diagnostics diagnostics={props.skill.diagnostics} />
    </div>
  );
};

const SkillMarkdownEditor = (props: { onSnapshot: (snapshot: SkillManagementSnapshot) => void; skillName: string }) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [message, setMessage] = createSignal<string | null>(null);
  const [document, { mutate, refetch }] = createResource(
    () => props.skillName,
    async (skillName) => (await getManagedSkillMarkdown({ data: skillName })) as SkillMarkdownResult,
  );
  const markdownDocument = createMemo(() => {
    const current = document();
    return current?.ok ? current.data : undefined;
  });
  const markdownError = createMemo(() => {
    const current = document();
    return current?.ok === false ? current.error.message : 'SKILL.md unavailable.';
  });

  createEffect(() => {
    const current = markdownDocument();
    if (current && !editing()) {
      setDraft(current.content);
    }
  });

  const saveMarkdown = async () => {
    const current = markdownDocument();
    if (!current) {
      return;
    }
    setMessage(null);
    const result = (await saveManagedSkillMarkdown({
      data: { baseSha256: current.sha256, content: draft(), skillName: props.skillName },
    })) as SkillMarkdownSaveResult;
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    if (result.data.reason === 'conflict') {
      setMessage('File changed on disk - reload the skill and reapply your edit.');
      return;
    }
    if (result.data.reason) {
      setMessage(`Could not save SKILL.md: ${result.data.reason}.`);
      return;
    }
    if (result.data.document) {
      mutate({ ok: true, data: result.data.document });
      setDraft(result.data.document.content);
    } else {
      await refetch();
    }
    if (result.data.snapshot) {
      props.onSnapshot(result.data.snapshot);
    }
    setEditing(false);
    setMessage('SKILL.md saved.');
  };

  return (
    <section class={section}>
      <div class={panelHeader}>
        <h3 class={panelTitle}>SKILL.md</h3>
        <p class={panelSub}>Writes to the source repository only, never into runtime folders.</p>
      </div>
      <Show fallback={<p class={meta}>Loading SKILL.md...</p>} when={!document.loading}>
        <Show fallback={<p class={meta}>{markdownError()}</p>} when={markdownDocument()}>
          {(current) => (
            <Show
              fallback={
                <>
                  <MarkdownPreview content={current().content} />
                  <button class={ghostButton} onClick={() => setEditing(true)} type="button">
                    Edit
                  </button>
                </>
              }
              when={editing()}
            >
              <textarea
                aria-label={`${props.skillName} SKILL.md`}
                class={editorArea}
                onInput={(event) => setDraft(event.currentTarget.value)}
                value={draft()}
              />
              <div class={actionRow}>
                <button class={commandButton} onClick={saveMarkdown} type="button">
                  Save
                </button>
                <button
                  class={ghostButton}
                  onClick={() => {
                    setDraft(current().content);
                    setEditing(false);
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </Show>
          )}
        </Show>
      </Show>
      <Show when={message()}>{(value) => <p class={meta}>{value()}</p>}</Show>
    </section>
  );
};

const ProjectScopeDetail = (props: {
  inventory: ProjectSkillInventory | undefined;
  loading: boolean;
  onSelect: (selection: SkillSelection) => void;
  projectPath: string;
}) => {
  const rows = createMemo(() => (props.inventory ? buildProjectSkillRows(props.inventory) : []));
  const exposed = createMemo(
    () => props.inventory?.observations.filter((observation) => observation.placement === 'symlink-to-source') ?? [],
  );
  return (
    <div class={detailStack}>
      <div class={hero}>
        <h2 class={skillTitle}>{props.projectPath.split('/').filter(Boolean).at(-1) ?? props.projectPath}</h2>
        <p class={pathText}>{props.projectPath}</p>
      </div>
      <Show fallback={<p class={meta}>Loading project skills...</p>} when={!props.loading}>
        <div class={metadataGrid}>
          <MetadataItem label="Observed skills" value={String(rows().length)} />
          <MetadataItem label="Global exposed here" value={String(exposed().length)} />
          <MetadataItem label="Diagnostics" value={String(props.inventory?.diagnostics.length ?? 0)} />
          <MetadataItem label="Runtime directories" value={String(projectSkillDirectories.length)} />
        </div>
        <section class={section}>
          <div class={panelHeader}>
            <h3 class={panelTitle}>Project skills</h3>
            <p class={panelSub}>Read-only inventory from project runtime directories.</p>
          </div>
          <Show fallback={<p class={meta}>No project-owned skills observed.</p>} when={rows().length > 0}>
            <div class={compactList}>
              <For each={rows()}>
                {(row) => (
                  <button
                    class={compactRow}
                    onClick={() =>
                      props.onSelect({ projectPath: props.projectPath, skillName: row.name, type: 'project-skill' })
                    }
                    type="button"
                  >
                    <span>
                      <span class={strongCell}>{row.name}</span>
                      <span class={meta}> {row.description || 'No description'}</span>
                    </span>
                    <span class={cx(statusPill, validationPillClass(row.validationStatus))}>
                      {row.validationStatus}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </section>
        <Diagnostics diagnostics={props.inventory?.diagnostics ?? []} />
      </Show>
    </div>
  );
};

const ProjectSkillDetail = (props: {
  onSelect: (selection: SkillSelection) => void;
  projectPath: string;
  row: ProjectSkillRow;
  tree: SkillTreeModel;
}) => {
  const diagnostics = createMemo(() => props.row.observations.flatMap((observation) => observation.diagnostics));
  const duplicateMatches = createMemo(() =>
    skillScopeMatches(
      props.tree,
      props.row.name,
      selectionKey({ projectPath: props.projectPath, skillName: props.row.name, type: 'project-skill' }),
    ),
  );
  return (
    <div class={detailStack}>
      <div class={hero}>
        <div class={titleRow}>
          <h2 class={skillTitle}>{props.row.name}</h2>
          <span class={cx(statusPill, validationPillClass(props.row.validationStatus))}>
            {props.row.validationStatus}
          </span>
          <span class={cx(statusPill, statusPillInfo)}>{props.row.invocation === 'auto' ? 'Auto' : 'Manual'}</span>
          <span class={cx(statusPill, statusPillInfo)}>Project</span>
        </div>
        <p class={muted}>{props.row.description || 'No description'}</p>
        <DuplicateSkillLinks matches={duplicateMatches()} onSelect={props.onSelect} />
      </div>
      <div class={metadataGrid}>
        <MetadataItem label="Project" value={props.projectPath} />
        <MetadataItem label="Tokens" value={props.row.tokenTotal ? `${props.row.tokenTotal} tok` : 'Unknown'} />
        <MetadataItem label="Observed runtimes" value={String(props.row.observations.length)} />
        <MetadataItem label="Diagnostics" value={String(diagnostics().length)} />
      </div>
      <section class={section}>
        <div class={panelHeader}>
          <h3 class={panelTitle}>Project runtime placement</h3>
          <p class={panelSub}>Project-owned skills are inspected here but not edited yet.</p>
        </div>
        <For each={props.row.observations}>
          {(observation) => (
            <div class={exposureRow}>
              <HarnessBadge name={runtimeLabels.get(observation.runtimeDirId) ?? observation.runtimeDirId} />
              <div>
                <div class={cx(strongCell, exposureStateClass(observation.placement))}>
                  {projectPlacementLabel(observation.placement)}
                </div>
                <div class={pathText} title={observation.skillMdPath}>
                  {observation.skillMdPath}
                </div>
              </div>
            </div>
          )}
        </For>
      </section>
      <ProjectSkillMarkdownViewer projectPath={props.projectPath} row={props.row} />
      <Diagnostics diagnostics={diagnostics()} />
    </div>
  );
};

const DuplicateSkillLinks = (props: {
  matches: readonly { scopeLabel: string; selection: SkillSelection }[];
  onSelect: (selection: SkillSelection) => void;
}) => (
  <Show when={props.matches.length > 0}>
    <div class={chipRow}>
      <span class={meta}>Also present in:</span>
      <For each={props.matches}>
        {(match) => (
          <button class={chipButton} onClick={() => props.onSelect(match.selection)} type="button">
            {match.scopeLabel}
          </button>
        )}
      </For>
    </div>
  </Show>
);

const ProjectSkillMarkdownViewer = (props: { projectPath: string; row: ProjectSkillRow }) => {
  const [runtimeDirId, setRuntimeDirId] = createSignal<ProjectRuntimeDirId>(
    props.row.observations.at(0)?.runtimeDirId ?? 'claude-project',
  );
  const selectedObservation = createMemo(
    () =>
      props.row.observations.find((observation) => observation.runtimeDirId === runtimeDirId()) ??
      props.row.observations.at(0),
  );
  const [document] = createResource(
    () => {
      const observation = selectedObservation();
      return observation === undefined
        ? undefined
        : {
            projectPath: props.projectPath,
            runtimeDirId: observation.runtimeDirId,
            skillName: props.row.name,
          };
    },
    async (input) => (await getProjectSkillMarkdown({ data: input })) as ProjectSkillMarkdownResult,
  );
  const markdownDocument = createMemo(() => {
    const current = document();
    return current?.ok ? current.data : undefined;
  });
  const markdownError = createMemo(() => {
    const current = document();
    return current?.ok === false ? current.error.message : 'SKILL.md unavailable.';
  });

  createEffect(() => {
    const firstRuntime = props.row.observations.at(0)?.runtimeDirId;
    if (
      firstRuntime !== undefined &&
      !props.row.observations.some((observation) => observation.runtimeDirId === runtimeDirId())
    ) {
      setRuntimeDirId(firstRuntime);
    }
  });

  return (
    <section class={section}>
      <div class={panelHeaderRow}>
        <div>
          <h3 class={panelTitle}>SKILL.md - read-only</h3>
          <p class={panelSub}>Project runtime content is visible here but not edited.</p>
        </div>
        <Show when={props.row.observations.length > 1}>
          <select
            aria-label="Project skill runtime"
            class={runtimeSelect}
            onChange={(event) => setRuntimeDirId(event.currentTarget.value as ProjectRuntimeDirId)}
            value={runtimeDirId()}
          >
            <For each={props.row.observations}>
              {(observation) => (
                <option value={observation.runtimeDirId}>
                  {runtimeLabels.get(observation.runtimeDirId) ?? observation.runtimeDirId}
                </option>
              )}
            </For>
          </select>
        </Show>
      </div>
      <Show fallback={<p class={meta}>Loading SKILL.md...</p>} when={!document.loading}>
        <Show fallback={<p class={meta}>{markdownError()}</p>} when={markdownDocument()}>
          {(current) => (
            <>
              <Show when={current().truncated}>
                <p class={meta}>Preview truncated to 64 KiB.</p>
              </Show>
              <MarkdownPreview content={current().content} />
            </>
          )}
        </Show>
      </Show>
    </section>
  );
};

const Diagnostics = (props: { diagnostics: readonly SkillDiagnostic[] }) => (
  <Show when={props.diagnostics.length > 0}>
    <section class={section}>
      <div class={panelHeader}>
        <h3 class={panelTitle}>Diagnostics</h3>
      </div>
      <For each={props.diagnostics}>
        {(diagnostic) => (
          <div class={diagnosticRow}>
            <span class={cx(statusPill, diagnosticPillClass(diagnostic))}>{diagnostic.severity}</span>
            <div class={strongCell}>{diagnostic.code}</div>
            <div class={meta}>{diagnostic.message}</div>
          </div>
        )}
      </For>
    </section>
  </Show>
);
