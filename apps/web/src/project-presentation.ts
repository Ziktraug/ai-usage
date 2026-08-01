export type ProjectDataQualityLabel = 'Filename-like' | 'No detected project' | 'Worktree-like';

const FILENAME_LIKE_PATTERN = /\.csv$/i;
const PROJECT_PATH_SEPARATOR_PATTERN = /[/\\]/;
const WORKTREE_LIKE_PATTERN = /^(agent|worktree)-[a-z0-9][a-z0-9-]*$/i;

const projectBasename = (projectLabel: string): string => {
  const segments = projectLabel.split(PROJECT_PATH_SEPARATOR_PATTERN);
  return segments.at(-1) ?? projectLabel;
};

export const projectDataQualityLabel = (projectLabel: string): ProjectDataQualityLabel | null => {
  if (projectLabel === '(unknown)') {
    return 'No detected project';
  }
  const basename = projectBasename(projectLabel);
  if (FILENAME_LIKE_PATTERN.test(basename)) {
    return 'Filename-like';
  }
  if (WORKTREE_LIKE_PATTERN.test(basename)) {
    return 'Worktree-like';
  }
  return null;
};
