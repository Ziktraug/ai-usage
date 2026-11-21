export const projectSkillDirectories = [
  { id: 'claude-project', label: 'Claude Code', relativePath: '.claude/skills' },
  { id: 'agents-project', label: 'Standard Agents', relativePath: '.agents/skills' },
] as const;

export type ProjectRuntimeDirId = (typeof projectSkillDirectories)[number]['id'];
