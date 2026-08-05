<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, skillsDisclosurePanel, skillsDisclosureSummary } from '@ai-usage/design-system/report';
  import type { SkillManagementSnapshot } from '@ai-usage/skills';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { applySkillsConfigurationSnapshotToCache } from '../../../query/options/skills';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
  import { createSkillsClient } from '../../../rpc/skills-client';
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import {
    editSourceRepositoryDraft,
    runSkillsConfigurationOperation,
    type SkillsConfigurationClient,
    type SkillsConfigurationOperation,
    skillsConfigInput,
    skillsConfigurationRefreshesDependents,
    sourceRepositoryDraftFrom,
    syncSourceRepositoryDraft,
  } from './model';
  import { button, compactStack, errorNotice, heading, muted, notice, pathText, primaryButton } from './styles';

  let {
    client: injectedClient,
    context,
  }: {
    client?: SkillsConfigurationClient;
    context: SkillsShellSlotContext;
  } = $props();

  const queryClient = useQueryClient();
  let browserClient: SkillsConfigurationClient | undefined;
  let observedSourceRepoPath = $state(untrack(() => context.snapshot.config.sourceRepoPath ?? ''));
  let sourceDraft = $state(untrack(() => sourceRepositoryDraftFrom(context.snapshot)));
  let projectPathDraft = $state('');
  let pendingOperation = $state<string | null>(null);
  let operationMessage = $state<{ message: string; tone: 'error' | 'success' } | null>(null);

  const resolveClient = (): SkillsConfigurationClient => {
    browserClient ??=
      injectedClient ?? createSkillsClient(createBrowserWebRpcClient('skills-management-configuration').skills);
    return browserClient;
  };
  const busyAttributes = (busy: boolean) =>
    ({
      'aria-busy': busy ? 'true' : 'false',
    }) as const;

  const execute = async (
    operation: SkillsConfigurationOperation,
    pendingLabel: string,
    successMessage: string,
  ): Promise<SkillManagementSnapshot | undefined> => {
    if (pendingOperation !== null) {
      return;
    }
    pendingOperation = pendingLabel;
    operationMessage = null;
    try {
      const client = resolveClient();
      const result = await runSkillsConfigurationOperation(client, operation);
      if (!result.ok) {
        operationMessage = { message: result.error, tone: 'error' };
        return;
      }
      await applySkillsConfigurationSnapshotToCache(
        queryClient,
        client,
        result.snapshot,
        skillsConfigurationRefreshesDependents(operation),
      );
      operationMessage = { message: successMessage, tone: 'success' };
      return result.snapshot;
    } catch (error) {
      operationMessage = {
        message: error instanceof Error ? error.message : 'Skills are unavailable.',
        tone: 'error',
      };
      return;
    } finally {
      pendingOperation = null;
    }
  };

  const saveSource = async (): Promise<void> => {
    const savedSnapshot = await execute(
      {
        config: skillsConfigInput(context.snapshot, { sourceRepoPath: sourceDraft.value }),
        type: 'save-config',
      },
      'save-config',
      'Skill source saved.',
    );
    if (savedSnapshot) {
      sourceDraft = sourceRepositoryDraftFrom(savedSnapshot);
      observedSourceRepoPath = sourceDraft.value;
    }
  };

  const addProjectPath = async (): Promise<void> => {
    const projectPath = projectPathDraft.trim();
    const projectPaths = context.snapshot.config.projectPaths ?? [];
    if (projectPath.length === 0 || projectPaths.includes(projectPath)) {
      return;
    }
    const saved = await execute(
      {
        config: skillsConfigInput(context.snapshot, { projectPaths: [...projectPaths, projectPath] }),
        type: 'save-config',
      },
      `project:add:${projectPath}`,
      `Project path added: ${projectPath}.`,
    );
    if (saved) {
      projectPathDraft = '';
    }
  };

  const removeProjectPath = (projectPath: string) =>
    execute(
      {
        config: skillsConfigInput(context.snapshot, {
          projectPaths: (context.snapshot.config.projectPaths ?? []).filter((value) => value !== projectPath),
        }),
        type: 'save-config',
      },
      `project:remove:${projectPath}`,
      `Project path removed: ${projectPath}.`,
    );

  const createTargetDirectory = (targetId: string) =>
    execute({ targetId, type: 'create-target' }, `target:${targetId}`, `Created target directory ${targetId}.`);

  $effect(() => {
    const nextSourceRepoPath = context.snapshot.config.sourceRepoPath ?? '';
    if (nextSourceRepoPath === observedSourceRepoPath) {
      return;
    }
    observedSourceRepoPath = nextSourceRepoPath;
    sourceDraft = syncSourceRepositoryDraft(sourceDraft, context.snapshot);
  });

  const body = css({ display: 'grid', gap: '16px', pt: '8px' });
  const formRow = css({ display: 'grid', gap: '8px' });
  const label = css({ display: 'grid', gap: '5px', color: 'muted', fontSize: '12px', fontWeight: 650 });
  const input = css({
    minW: 0,
    h: '36px',
    px: '10px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    fontSize: '13px',
  });
  const actionRow = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'end' });
  const projectRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'center',
  });
  const targetRow = css({ display: 'grid', gap: '5px', pt: '8px', borderTop: '1px solid token(colors.line)' });
</script>

<details class={cx(panel, skillsDisclosurePanel)} data-skills-configuration>
  <summary class={skillsDisclosureSummary}>
    <strong>Configuration &amp; runtimes</strong>
    <span class={muted}>
      {context.snapshot.targets.filter((target) => target.enabled).length}
      enabled /
      {context.snapshot.targets.length}
      configured
    </span>
  </summary>
  <div class={body}>
    <section class={compactStack}>
      <label class={label}>
        <span>Source repository</span>
        <input
          class={input}
          name="sourceRepoPath"
          oninput={(event) => {
            sourceDraft = editSourceRepositoryDraft(event.currentTarget.value, context.snapshot);
          }}
          value={sourceDraft.value}
        >
        <span>Repository that owns shared skills, expected at `skills/*/SKILL.md`.</span>
      </label>
      <button
        {...busyAttributes(pendingOperation === 'save-config')}
        class={cx(button, primaryButton)}
        disabled={pendingOperation !== null}
        onclick={saveSource}
        type="button"
      >
        Save source
      </button>
    </section>

    <section class={compactStack}>
      <h3 class={heading}>Project paths</h3>
      <p class={muted}>Pick from projects already present in the report, or add a path manually.</p>
      <div class={formRow}>
        <label class={label}>
          <span>Scanned project</span>
          <select
            class={input}
            oninput={(event) => {
              projectPathDraft = event.currentTarget.value;
            }}
            value={projectPathDraft}
          >
            <option value="">Select a project</option>
            {#each context.view.knownProjects as project (project.path)}
              <option
                disabled={(context.snapshot.config.projectPaths ?? []).includes(project.path)}
                value={project.path}
              >
                {project.label}
                · {project.path}
              </option>
            {/each}
          </select>
        </label>
        <label class={label}>
          <span>Manual path</span>
          <input
            class={input}
            oninput={(event) => {
              projectPathDraft = event.currentTarget.value;
            }}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addProjectPath();
              }
            }}
            value={projectPathDraft}
          >
          <span>Use this when the project has not appeared in the report yet.</span>
        </label>
        <button
          class={button}
          disabled={pendingOperation !== null || projectPathDraft.trim().length === 0}
          onclick={addProjectPath}
          type="button"
        >
          Add
        </button>
      </div>
      {#if (context.snapshot.config.projectPaths ?? []).length === 0}
        <p class={muted}>No manual project paths.</p>
      {:else}
        {#each context.snapshot.config.projectPaths ?? [] as projectPath (projectPath)}
          <div class={projectRow}>
            <span class={pathText}>{projectPath}</span>
            <button
              class={button}
              disabled={pendingOperation !== null}
              onclick={() => removeProjectPath(projectPath)}
              type="button"
            >
              Remove
            </button>
          </div>
        {/each}
      {/if}
    </section>

    <section class={compactStack}>
      <h3 class={heading}>Runtimes</h3>
      <p class={muted}>
        {context.snapshot.targets.filter((target) => target.enabled).length}
        enabled /
        {context.snapshot.summary.targetCount}
        configured
      </p>
      {#each context.snapshot.targets as target (target.id)}
        <div class={targetRow}>
          <strong>{target.label}</strong>
          <span class={muted}>
            {target.enabled ? 'Enabled' : 'Disabled'}
            · {target.missing ? 'Missing directory' : 'Observed'} ·
            {target.path}
          </span>
          {#if target.missing}
            <div class={actionRow}>
              <button
                {...busyAttributes(pendingOperation === `target:${target.id}`)}
                class={button}
                disabled={pendingOperation !== null}
                onclick={() => createTargetDirectory(target.id)}
                type="button"
              >
                Create directory
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </section>

    {#each context.snapshot.diagnostics.filter((diagnostic) => diagnostic.skillName === undefined) as diagnostic}
      <p class={muted}>{diagnostic.severity}: {diagnostic.message}</p>
    {/each}
  </div>
</details>

{#if operationMessage?.tone === 'error'}
  <p class={cx(notice, errorNotice)} role="alert">{operationMessage.message}</p>
{:else if operationMessage}
  <p aria-live="polite" class={notice} role="status">{operationMessage.message}</p>
{/if}
