import type { CheckoutId, Instant, ProjectId } from '@ai-usage/platform-core/identity';

export interface ProjectSourceMapping {
  readonly acknowledgedAt: Instant;
  readonly checkoutId: CheckoutId;
  readonly projectId: ProjectId;
  readonly projectSourceId: string;
}

export interface ProjectSourceMappingReader {
  readonly findByProjectSourceId: (projectSourceId: string) => Promise<ProjectSourceMapping | null>;
}

export interface ProjectSourceMappingWriter {
  readonly acknowledge: (mapping: ProjectSourceMapping) => Promise<void>;
}
