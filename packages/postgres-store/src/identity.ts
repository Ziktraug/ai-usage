import type {
  CaptureContext,
  Checkout,
  CheckoutId,
  Device,
  Person,
  Project,
  ProjectId,
  Repository,
  RepositoryAlias,
  RepositoryId,
  ScmAccount,
  ScmCredential,
  ScmInstallation,
  Space,
  SpaceId,
} from '@ai-usage/platform-core/identity';
import type { ProjectSourceMapping } from '@ai-usage/project-registry/mapping';
import type { RepositoryResolution, RepositoryResolutionCandidate } from '@ai-usage/project-registry/resolution';
import type {
  CheckoutResolutionAction,
  CheckoutResolutionActionResult,
  CheckoutResolutionReview,
} from '@ai-usage/project-registry/review';

export interface SharedPersonalIdentity {
  readonly person: Person;
  readonly space: Space;
}

export interface SharedRepositoryIdentityUpdate {
  readonly canonicalHost: string;
  readonly canonicalName: string;
  readonly canonicalOwner: string | null;
  readonly eventType: 'repository-renamed' | 'repository-transferred';
  readonly repositoryId: RepositoryId;
  readonly spaceId: SpaceId;
  readonly status: Repository['status'];
}

export interface PlatformIdentityStore {
  readonly acknowledgeProjectSourceMapping: (mapping: ProjectSourceMapping, spaceId: SpaceId) => Promise<void>;
  readonly applyResolutionAction: (action: CheckoutResolutionAction) => Promise<CheckoutResolutionActionResult>;
  readonly attachProjectRepository: (input: {
    readonly projectId: ProjectId;
    readonly repositoryId: RepositoryId;
    readonly repositorySubpath: string | null;
    readonly spaceId: SpaceId;
  }) => Promise<void>;
  readonly createDevice: (device: Device) => Promise<void>;
  readonly createPersonalIdentity: (identity: SharedPersonalIdentity) => Promise<void>;
  readonly createProject: (project: Project) => Promise<void>;
  readonly createRepositoryWithAlias: (repository: Repository, alias: RepositoryAlias) => Promise<void>;
  readonly createScmAccount: (account: ScmAccount) => Promise<void>;
  readonly createScmCredential: (credential: ScmCredential) => Promise<void>;
  readonly createScmInstallation: (installation: ScmInstallation) => Promise<void>;
  readonly findProjectSourceMapping: (
    spaceId: SpaceId,
    projectSourceId: string,
  ) => Promise<ProjectSourceMapping | null>;
  readonly listRepositoryCandidates: (spaceId: SpaceId) => Promise<readonly RepositoryResolutionCandidate[]>;
  readonly listResolutionReviews: (spaceId: SpaceId) => Promise<readonly CheckoutResolutionReview[]>;
  readonly recordRepositoryResolution: (
    spaceId: SpaceId,
    checkoutId: CheckoutId,
    resolution: RepositoryResolution,
  ) => Promise<void>;
  readonly saveCaptureContext: (context: CaptureContext) => Promise<void>;
  readonly updateRepositoryIdentity: (input: SharedRepositoryIdentityUpdate) => Promise<void>;
  readonly upsertCheckout: (spaceId: SpaceId, checkout: Checkout) => Promise<void>;
}
