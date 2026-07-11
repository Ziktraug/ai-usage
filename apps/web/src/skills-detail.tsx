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
import { useBlocker } from '@tanstack/solid-router';
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from 'solid-js';
import { DiscardConfirmationDialog } from './discard-confirmation-dialog';
import { type ProjectRuntimeDirId, projectSkillDirectories } from './project-skill-directories';
import { getManagedSkillMarkdown, getProjectSkillMarkdown, saveManagedSkillMarkdown } from './server/skills';
import { createSkillMarkdownEditorController, runSkillMarkdownEditorAction } from './skill-markdown-editor-model';
import {
  buildGlobalSkillExposure,
  buildProjectSkillRows,
  buildSkillHealthSummary,
  count,
  findGlobalSkill,
  findProjectSkillRow,
  globalSkillAttention,
  type KnownProjectScope,
  type ProjectSkillRow,
  type ProjectSkillRowObservation,
  projectSourcePathsForScope,
  type SkillSelection,
  type SkillTreeModel,
  selectionKey,
  skillInvocation,
  skillScopeMatches,
} from './skills-page-model';
import { SkillSelectionLink } from './skills-selection-link';
import type { ProjectInventoriesResult, SkillMarkdownDraftGuard } from './skills-workspace';

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

const editorLoadingBlock = css({
  display: 'grid',
  minH: '360px',
  placeItems: 'center',
  p: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
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
  if (
    state === 'linked' ||
    state === 'symlink-to-source' ||
    state === 'project-symlink' ||
    state === 'owned-directory'
  ) {
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
  if (placement === 'project-symlink') {
    return 'Symlink within project';
  }
  if (placement === 'external-symlink') {
    return 'External symlink';
  }
  return 'Owned project skill';
};

const attentionPillClass = (skill: SourceSkill, issueCount: number) => {
  if (!skill.enabled) {
    return statusPillInfo;
  }
  if (skill.validationStatus === 'invalid') {
    return statusPillDanger;
  }
  return issueCount > 0 ? statusPillWarn : statusPillInfo;
};

const attentionPillText = (skill: SourceSkill, issueCount: number) => {
  if (!skill.enabled) {
    return 'disabled';
  }
  if (skill.validationStatus === 'invalid') {
    return 'invalid';
  }
  return count(issueCount, 'issue');
};

const MetadataItem = (props: { label: string; value: JSX.Element }) => (
  <div class={metadataItem}>
    <span class={metadataLabel}>{props.label}</span>
    <span class={wrapValue}>{props.value}</span>
  </div>
);

const MarkdownPreview = (props: { content: string }) => <pre class={editorBlock}>{props.content}</pre>;

const MarkdownLoading = () => (
  <div class={editorLoadingBlock}>
    <p class={meta}>Loading SKILL.md...</p>
  </div>
);

const errorResult = (error: unknown) => ({
  ok: false as const,
  error: { message: error instanceof Error ? error.message : String(error), tag: 'ClientRequestError' },
});

export const SkillsDetail = (props: {
  configurationPanel: () => JSX.Element;
  consolidatePanel: () => JSX.Element;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  onMarkdownDraftStateChange: (guard: SkillMarkdownDraftGuard | undefined) => void;
  pendingOperation: string | null;
  knownProjects: readonly KnownProjectScope[];
  markdownRefreshVersion: number;
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
    if (!(selection.type === 'project-scope' || selection.type === 'project-skill')) {
      return [];
    }
    const sourcePaths = new Set(projectSourcePathsForScope(selection.projectPath, props.knownProjects));
    return inventories().filter((inventory) => sourcePaths.has(inventory.projectPath));
  });
  const selectedProjectSkill = createMemo(() =>
    props.selection.type === 'project-skill'
      ? findProjectSkillRow(inventories(), props.selection.projectPath, props.selection.skillName, props.knownProjects)
      : undefined,
  );
  const selectedProjectScope = createMemo(() => {
    const selection = props.selection;
    return selection.type === 'project-scope' || selection.type === 'project-skill'
      ? props.knownProjects.find((project) => project.path === selection.projectPath)
      : undefined;
  });

  return (
    <section aria-label="Skill detail" class={cx(panel, detailStack)}>
      <Show when={props.selection.type === 'global-scope'}>
        <GlobalScopeDetail
          configurationPanel={props.configurationPanel}
          consolidatePanel={props.consolidatePanel}
          knownProjects={props.knownProjects}
          snapshot={props.snapshot}
        />
      </Show>
      <Show when={selectedGlobalSkill()}>
        {(skill) => (
          <GlobalSkillDetail
            knownProjects={props.knownProjects}
            markdownRefreshVersion={props.markdownRefreshVersion}
            onMarkdownDraftStateChange={props.onMarkdownDraftStateChange}
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
          inventories={selectedProjectInventory()}
          knownProjects={props.knownProjects}
          label={selectedProjectScope()?.label}
          loading={props.projectInventoriesLoading}
          projectPath={props.selection.type === 'project-scope' ? props.selection.projectPath : ''}
          sourcePaths={projectSourcePathsForScope(
            props.selection.type === 'project-scope' ? props.selection.projectPath : '',
            props.knownProjects,
          )}
        />
      </Show>
      <Show when={selectedProjectSkill()}>
        {(row) => (
          <ProjectSkillDetail
            knownProjects={props.knownProjects}
            label={selectedProjectScope()?.label}
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
  knownProjects: readonly KnownProjectScope[];
  snapshot: SkillManagementSnapshot;
}) => {
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const attentionSkills = createMemo(() =>
    props.snapshot.skills
      .map((skill) => ({ attention: globalSkillAttention(props.snapshot, skill), skill }))
      .filter(
        (entry) => entry.attention.issueCount > 0 || entry.skill.validationStatus !== 'valid' || !entry.skill.enabled,
      )
      .sort((left, right) => {
        if (left.attention.issueCount !== right.attention.issueCount) {
          return right.attention.issueCount - left.attention.issueCount;
        }
        return left.skill.name.localeCompare(right.skill.name);
      })
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
          <p class={panelSub}>Exposure issues first, then invalid or disabled skills.</p>
        </div>
        <Show fallback={<p class={meta}>No skills need attention.</p>} when={attentionSkills().length > 0}>
          <div class={compactList}>
            <For each={attentionSkills()}>
              {(entry) => {
                const selection = { skillName: entry.skill.name, type: 'global-skill' } as const;
                return (
                  <SkillSelectionLink class={compactRow} knownProjects={props.knownProjects} selection={selection}>
                    <span>
                      <span class={strongCell}>{entry.skill.name}</span>
                      <span class={meta}> {entry.skill.description || 'No description'}</span>
                    </span>
                    <span
                      class={cx(statusPill, attentionPillClass(entry.skill, entry.attention.issueCount))}
                      title={entry.attention.attentionSummary || undefined}
                    >
                      {attentionPillText(entry.skill, entry.attention.issueCount)}
                    </span>
                  </SkillSelectionLink>
                );
              }}
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
  onMarkdownDraftStateChange: (guard: SkillMarkdownDraftGuard | undefined) => void;
  knownProjects: readonly KnownProjectScope[];
  markdownRefreshVersion: number;
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
        <DuplicateSkillLinks knownProjects={props.knownProjects} matches={duplicateMatches()} />
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
      <SkillMarkdownEditor
        onDraftStateChange={props.onMarkdownDraftStateChange}
        onSnapshot={props.onSnapshot}
        refreshVersion={props.markdownRefreshVersion}
        skillName={props.skill.name}
      />
      <Diagnostics diagnostics={props.skill.diagnostics} />
    </div>
  );
};

const SkillMarkdownEditor = (props: {
  onDraftStateChange: (guard: SkillMarkdownDraftGuard | undefined) => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  refreshVersion: number;
  skillName: string;
}) => {
  const controller = createSkillMarkdownEditorController({
    loadMarkdown: (skillName) => getManagedSkillMarkdown({ data: skillName }),
    onSnapshot: (snapshot) => props.onSnapshot(snapshot),
    saveMarkdown: (input) => saveManagedSkillMarkdown({ data: input }),
  });
  const [editorState, setEditorState] = createSignal(controller.getState());
  const [reloadRequested, setReloadRequested] = createSignal(false);
  let editorElement: HTMLTextAreaElement | undefined;
  let editorTriggerElement: HTMLButtonElement | undefined;
  const unsubscribe = controller.subscribe((state) => setEditorState(state));
  onCleanup(unsubscribe);

  const focusEditor = (): void => {
    (editorElement ?? editorTriggerElement)?.focus();
  };

  createEffect(() => {
    props.onDraftStateChange({
      discard: controller.cancelEditing,
      dirty: editorState().dirty,
      focus: focusEditor,
      skillName: props.skillName,
    });
  });
  onCleanup(() => props.onDraftStateChange(undefined));

  const navigationBlocker = useBlocker({
    enableBeforeUnload: () => editorState().dirty,
    shouldBlockFn: () => editorState().dirty,
    withResolver: true,
  });

  createEffect(() => {
    runSkillMarkdownEditorAction(controller, () => controller.select(props.skillName)).catch(
      controller.reportUnexpectedError,
    );
  });

  let observedRefreshVersion = props.refreshVersion;
  const reloadFromDisk = async (): Promise<void> => {
    if (editorState().dirty) {
      setReloadRequested(true);
      return;
    }
    await runSkillMarkdownEditorAction(controller, controller.reload);
  };

  const keepEditing = (): void => {
    setReloadRequested(false);
    const blocker = navigationBlocker();
    if (blocker.status === 'blocked') {
      blocker.reset();
    }
  };

  const discardChanges = async (): Promise<void> => {
    controller.cancelEditing();
    setReloadRequested(false);
    const blocker = navigationBlocker();
    if (blocker.status === 'blocked') {
      blocker.proceed();
      return;
    }
    await runSkillMarkdownEditorAction(controller, controller.reload);
  };

  createEffect(() => {
    const refreshVersion = props.refreshVersion;
    if (refreshVersion === observedRefreshVersion) {
      return;
    }
    observedRefreshVersion = refreshVersion;
    reloadFromDisk().catch(controller.reportUnexpectedError);
  });

  const markdownDocument = createMemo(() => editorState().document);
  const markdownError = createMemo(() => editorState().error ?? 'SKILL.md unavailable.');

  return (
    <section class={section}>
      <div class={panelHeader}>
        <h3 class={panelTitle}>SKILL.md</h3>
        <p class={panelSub}>Writes to the source repository only, never into runtime folders.</p>
      </div>
      <Show
        fallback={editorState().loading ? <MarkdownLoading /> : <p class={meta}>{markdownError()}</p>}
        when={markdownDocument()}
      >
        {(current) => (
          <Show
            fallback={
              <>
                <MarkdownPreview content={current().content} />
                <div class={actionRow}>
                  <button
                    class={ghostButton}
                    onClick={controller.startEditing}
                    ref={(element) => {
                      editorTriggerElement = element;
                    }}
                    type="button"
                  >
                    Edit
                  </button>
                  <button class={ghostButton} onClick={reloadFromDisk} type="button">
                    Reload from disk
                  </button>
                </div>
              </>
            }
            when={editorState().editing}
          >
            <textarea
              aria-label={`${editorState().skillName} SKILL.md`}
              class={editorArea}
              onInput={(event) => controller.setDraft(event.currentTarget.value)}
              ref={(element) => {
                editorElement = element;
              }}
              value={editorState().draft}
            />
            <div class={actionRow}>
              <button
                aria-busy={editorState().saving ? 'true' : undefined}
                class={commandButton}
                disabled={editorState().saving}
                onClick={async () => {
                  await runSkillMarkdownEditorAction(controller, controller.save);
                }}
                type="button"
              >
                Save
              </button>
              <button
                class={ghostButton}
                disabled={editorState().saving}
                onClick={controller.cancelEditing}
                type="button"
              >
                Cancel
              </button>
              <button class={ghostButton} disabled={editorState().saving} onClick={reloadFromDisk} type="button">
                Reload from disk
              </button>
            </div>
          </Show>
        )}
      </Show>
      <Show when={editorState().dirty}>
        <p class={meta}>Unsaved changes — navigation and reload require confirmation.</p>
      </Show>
      <Show when={editorState().message}>{(value) => <p class={meta}>{value()}</p>}</Show>
      <Show when={reloadRequested() || navigationBlocker().status === 'blocked'}>
        <DiscardConfirmationDialog
          description="Your SKILL.md draft has not been saved. Discarding it cannot be undone."
          idPrefix="discard-skill-draft"
          onDiscard={discardChanges}
          onKeep={keepEditing}
          restoreFocus={focusEditor}
        />
      </Show>
    </section>
  );
};

const ProjectScopeDetail = (props: {
  inventories: readonly ProjectSkillInventory[];
  knownProjects: readonly KnownProjectScope[];
  label?: string | undefined;
  loading: boolean;
  projectPath: string;
  sourcePaths: readonly string[];
}) => {
  const rows = createMemo(() => buildProjectSkillRows(props.inventories, props.knownProjects));
  const exposed = createMemo(() =>
    props.inventories.flatMap((inventory) =>
      inventory.observations.filter((observation) => observation.placement === 'symlink-to-source'),
    ),
  );
  const diagnostics = createMemo(() => props.inventories.flatMap((inventory) => inventory.diagnostics));
  const title = createMemo(
    () => props.label ?? props.projectPath.split('/').filter(Boolean).at(-1) ?? props.projectPath,
  );
  return (
    <div class={detailStack}>
      <div class={hero}>
        <h2 class={skillTitle}>{title()}</h2>
        <For each={props.sourcePaths}>{(sourcePath) => <p class={pathText}>{sourcePath}</p>}</For>
      </div>
      <Show fallback={<p class={meta}>Loading project skills...</p>} when={!props.loading}>
        <div class={metadataGrid}>
          <MetadataItem label="Observed skills" value={String(rows().length)} />
          <MetadataItem label="Global exposed here" value={String(exposed().length)} />
          <MetadataItem label="Diagnostics" value={String(diagnostics().length)} />
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
                {(row) => {
                  const selection = {
                    projectPath: props.projectPath,
                    skillName: row.name,
                    type: 'project-skill',
                  } as const;
                  return (
                    <SkillSelectionLink class={compactRow} knownProjects={props.knownProjects} selection={selection}>
                      <span>
                        <span class={strongCell}>{row.name}</span>
                        <span class={meta}> {row.description || 'No description'}</span>
                      </span>
                      <span class={cx(statusPill, validationPillClass(row.validationStatus))}>
                        {row.validationStatus}
                      </span>
                    </SkillSelectionLink>
                  );
                }}
              </For>
            </div>
          </Show>
        </section>
        <Diagnostics diagnostics={diagnostics()} />
      </Show>
    </div>
  );
};

const ProjectSkillDetail = (props: {
  knownProjects: readonly KnownProjectScope[];
  label?: string | undefined;
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
        <DuplicateSkillLinks knownProjects={props.knownProjects} matches={duplicateMatches()} />
      </div>
      <div class={metadataGrid}>
        <MetadataItem label="Project" value={props.label ?? props.projectPath} />
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
                <Show when={props.row.observations.length > 1}>
                  <div class={pathText}>{observation.projectPath}</div>
                </Show>
              </div>
            </div>
          )}
        </For>
      </section>
      <ProjectSkillMarkdownViewer row={props.row} />
      <Diagnostics diagnostics={diagnostics()} />
    </div>
  );
};

const DuplicateSkillLinks = (props: {
  knownProjects: readonly KnownProjectScope[];
  matches: readonly { scopeLabel: string; selection: SkillSelection }[];
}) => (
  <Show when={props.matches.length > 0}>
    <div class={chipRow}>
      <span class={meta}>Also present in:</span>
      <For each={props.matches}>
        {(match) => (
          <SkillSelectionLink class={chipButton} knownProjects={props.knownProjects} selection={match.selection}>
            {match.scopeLabel}
          </SkillSelectionLink>
        )}
      </For>
    </div>
  </Show>
);

const projectSkillObservationKey = (observation: ProjectSkillRowObservation): string =>
  JSON.stringify([observation.projectPath, observation.runtimeDirId]);

const ProjectSkillMarkdownViewer = (props: { row: ProjectSkillRow }) => {
  const firstObservationKey = () => {
    const observation = props.row.observations.at(0);
    return observation === undefined ? '' : projectSkillObservationKey(observation);
  };
  const [observationKey, setObservationKey] = createSignal(firstObservationKey());
  const selectedObservation = createMemo(
    () =>
      props.row.observations.find((observation) => projectSkillObservationKey(observation) === observationKey()) ??
      props.row.observations.at(0),
  );
  const duplicateRuntimeIds = createMemo(() => {
    const counts = new Map<ProjectRuntimeDirId, number>();
    for (const observation of props.row.observations) {
      counts.set(observation.runtimeDirId, (counts.get(observation.runtimeDirId) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, value]) => value > 1).map(([runtimeDirId]) => runtimeDirId));
  });
  const optionLabel = (observation: ProjectSkillRowObservation) => {
    const runtimeLabel = runtimeLabels.get(observation.runtimeDirId) ?? observation.runtimeDirId;
    if (!duplicateRuntimeIds().has(observation.runtimeDirId)) {
      return runtimeLabel;
    }
    return `${runtimeLabel} - ${observation.projectPath}`;
  };
  const [document, setDocument] = createSignal<ProjectSkillMarkdownResult>();
  const [documentLoading, setDocumentLoading] = createSignal(false);
  let documentRequestId = 0;

  createEffect(() => {
    const observation = selectedObservation();
    if (observation === undefined) {
      documentRequestId += 1;
      setDocument(undefined);
      setDocumentLoading(false);
      return;
    }

    documentRequestId += 1;
    const requestId = documentRequestId;
    setDocumentLoading(true);
    getProjectSkillMarkdown({
      data: {
        projectPath: observation.projectPath,
        runtimeDirId: observation.runtimeDirId,
        skillName: props.row.name,
      },
    })
      .then((result) => {
        if (requestId === documentRequestId) {
          setDocument(result as ProjectSkillMarkdownResult);
        }
      })
      .catch((error: unknown) => {
        if (requestId === documentRequestId) {
          setDocument(errorResult(error));
        }
      })
      .finally(() => {
        if (requestId === documentRequestId) {
          setDocumentLoading(false);
        }
      });
  });

  const markdownDocument = createMemo(() => {
    const current = document();
    return current?.ok ? current.data : undefined;
  });
  const markdownError = createMemo(() => {
    const current = document();
    return current?.ok === false ? current.error.message : 'SKILL.md unavailable.';
  });

  createEffect(() => {
    const firstKey = firstObservationKey();
    if (
      firstKey !== '' &&
      !props.row.observations.some((observation) => projectSkillObservationKey(observation) === observationKey())
    ) {
      setObservationKey(firstKey);
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
            onChange={(event) => setObservationKey(event.currentTarget.value)}
            value={observationKey()}
          >
            <For each={props.row.observations}>
              {(observation) => (
                <option value={projectSkillObservationKey(observation)}>{optionLabel(observation)}</option>
              )}
            </For>
          </select>
        </Show>
      </div>
      <Show
        fallback={documentLoading() ? <MarkdownLoading /> : <p class={meta}>{markdownError()}</p>}
        when={markdownDocument()}
      >
        {(current) => (
          <>
            <Show when={current().truncated}>
              <p class={meta}>Preview truncated to 64 KiB.</p>
            </Show>
            <MarkdownPreview content={current().content} />
          </>
        )}
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
