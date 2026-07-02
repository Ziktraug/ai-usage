import { css, cx } from '@ai-usage/design-system/css';
import {
  HarnessBadge,
  meta,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  statusDot,
  statusDotCopy,
  statusDotLinked,
  statusDotMissing,
  strongCell,
  table,
  tableWrap,
} from '@ai-usage/design-system/report';
import type { ProjectSkillInventory, ProjectSkillObservation } from '@ai-usage/skills';
import { createMemo, For, Show } from 'solid-js';

const projectSkillDirectories = [
  { id: 'claude-project', label: 'Claude Code' },
  { id: 'agents-project', label: 'Standard Agents' },
] as const;

const stack = css({
  display: 'grid',
  gap: '12px',
});

const projectTable = css({
  minW: '720px',
});

const pathText = css({
  fontFamily: 'mono',
  fontSize: '12px',
  color: 'muted',
  overflowWrap: 'anywhere',
});

const centerCell = css({
  textAlign: 'center',
});

const description = css({
  color: 'muted',
  fontSize: '12px',
});

const projectName = (projectPath: string) => projectPath.split('/').filter(Boolean).at(-1) ?? projectPath;

const dotFor = (observation: ProjectSkillObservation | undefined) => {
  if (observation === undefined) {
    return statusDotMissing;
  }
  if (observation.placement === 'external-symlink') {
    return statusDotCopy;
  }
  return statusDotLinked;
};

const titleFor = (observation: ProjectSkillObservation | undefined) => {
  if (observation === undefined) {
    return 'Not linked';
  }
  if (observation.placement === 'symlink-to-source') {
    return 'Global skill exposed here';
  }
  if (observation.placement === 'external-symlink') {
    return 'External symlink';
  }
  return 'Owned project skill';
};

const projectRows = (inventory: ProjectSkillInventory) => {
  const rows = new Map<
    string,
    { description: string; name: string; observations: Map<string, ProjectSkillObservation> }
  >();
  for (const observation of inventory.observations) {
    const existing = rows.get(observation.name) ?? {
      description: observation.description,
      name: observation.name,
      observations: new Map<string, ProjectSkillObservation>(),
    };
    existing.observations.set(observation.runtimeDirId, observation);
    rows.set(observation.name, existing);
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
};

export const SkillsProjects = (props: { inventories: readonly ProjectSkillInventory[] }) => (
  <div class={stack}>
    <Show
      fallback={
        <section class={panel}>
          <p class={meta}>No configured projects.</p>
        </section>
      }
      when={props.inventories.length > 0}
    >
      <For each={props.inventories}>
        {(inventory) => {
          const rows = createMemo(() => projectRows(inventory));
          const exposed = createMemo(() =>
            inventory.observations
              .filter((observation) => observation.placement === 'symlink-to-source')
              .map((observation) => observation.name),
          );
          return (
            <section class={panel}>
              <div class={panelHeader}>
                <h2 class={panelTitle}>{projectName(inventory.projectPath)}</h2>
                <p class={panelSub}>{inventory.projectPath}</p>
              </div>
              <Show fallback={<p class={meta}>No project-owned skills observed.</p>} when={rows().length > 0}>
                <div class={tableWrap}>
                  <table class={cx(table, projectTable)}>
                    <thead>
                      <tr>
                        <th>Skill</th>
                        <For each={projectSkillDirectories}>
                          {(directory) => (
                            <th>
                              <HarnessBadge name={directory.label} />
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={rows()}>
                        {(row) => (
                          <tr>
                            <td>
                              <div class={strongCell}>{row.name}</div>
                              <div class={description}>{row.description || 'No description'}</div>
                            </td>
                            <For each={projectSkillDirectories}>
                              {(directory) => {
                                const observation = () => row.observations.get(directory.id);
                                return (
                                  <td class={centerCell}>
                                    <span
                                      aria-label={titleFor(observation())}
                                      class={cx(statusDot, dotFor(observation()))}
                                      role="img"
                                      title={titleFor(observation())}
                                    />
                                  </td>
                                );
                              }}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
              <Show when={exposed().length > 0}>
                <p class={meta}>
                  + {exposed().length} global skills exposed here: {exposed().join(', ')}
                </p>
              </Show>
              <For each={inventory.diagnostics}>
                {(diagnostic) => (
                  <p class={meta}>
                    {diagnostic.severity}: {diagnostic.message}
                  </p>
                )}
              </For>
              <div class={pathText}>{inventory.projectPath}</div>
            </section>
          );
        }}
      </For>
    </Show>
  </div>
);
