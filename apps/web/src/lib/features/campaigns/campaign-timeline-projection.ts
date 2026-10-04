import type { CampaignTimeline, CampaignTimelineProject } from './campaign-timeline-model';

/** Appends project continuations instead of inserting newly discovered campaigns above the reader. */
export const campaignProjectSegments = (
  timeline: CampaignTimeline,
  acquisition: readonly (readonly string[])[],
): readonly { key: string; continuation: boolean; project: CampaignTimelineProject }[] => {
  const campaigns = new Map(
    timeline.groups.flatMap((project) =>
      project.campaigns.map((campaign) => [campaign.item.campaignKey, { campaign, project }] as const),
    ),
  );
  const seen = new Set<string>();
  return acquisition.flatMap((keys) => {
    const groups = new Map<string, CampaignTimelineProject>();
    for (const key of keys) {
      const entry = campaigns.get(key);
      if (!entry) {
        continue;
      }
      const previous = groups.get(entry.project.projectKey);
      groups.set(entry.project.projectKey, {
        ...entry.project,
        campaigns: [...(previous?.campaigns ?? []), entry.campaign],
      });
    }
    return [...groups.values()].map((project) => {
      const continuation = seen.has(project.projectKey);
      seen.add(project.projectKey);
      return {
        key: continuation
          ? `project-continuation:${project.campaigns[0]?.item.campaignKey}`
          : `project:${project.projectKey}`,
        continuation,
        project,
      };
    });
  });
};
