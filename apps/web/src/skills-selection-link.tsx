import { Link } from '@tanstack/solid-router';
import type { JSX } from 'solid-js';
import { type KnownProjectScope, projectRouteKey, type SkillSelection } from './skills-page-model';

// TanStack Link owns aria-current: it sets "page" on URL-active links with
// prefix matching (so `/skills` is "active" under `/skills/global/x` too).
// Visual selection therefore rides on data-selected, never on aria-current.
export const SkillSelectionLink = (props: {
  children: JSX.Element;
  class: string;
  knownProjects: readonly KnownProjectScope[];
  selected?: boolean;
  selection: SkillSelection;
  title?: string | undefined;
}) => {
  const selectedFlag = () => (props.selected ? 'true' : undefined);
  if (props.selection.type === 'global-scope') {
    return (
      <Link class={props.class} data-selected={selectedFlag()} resetScroll={false} title={props.title} to="/skills">
        {props.children}
      </Link>
    );
  }
  if (props.selection.type === 'global-skill') {
    return (
      <Link
        class={props.class}
        data-selected={selectedFlag()}
        params={{ skillName: props.selection.skillName }}
        resetScroll={false}
        title={props.title}
        to="/skills/global/$skillName"
      >
        {props.children}
      </Link>
    );
  }
  if (props.selection.type === 'project-scope') {
    return (
      <Link
        class={props.class}
        data-selected={selectedFlag()}
        params={{ projectKey: projectRouteKey(props.selection.projectPath, props.knownProjects) }}
        resetScroll={false}
        title={props.title}
        to="/skills/projects/$projectKey"
      >
        {props.children}
      </Link>
    );
  }
  return (
    <Link
      class={props.class}
      data-selected={selectedFlag()}
      params={{
        projectKey: projectRouteKey(props.selection.projectPath, props.knownProjects),
        skillName: props.selection.skillName,
      }}
      resetScroll={false}
      title={props.title}
      to="/skills/projects/$projectKey/$skillName"
    >
      {props.children}
    </Link>
  );
};
