import { parseActorSubject } from "../domain/foundation.ts";
import { isConfiguredOwner } from "../domain/owner-identity.ts";
import {
  authorizeParticipantAccess,
  type AuthorizedParticipantAccess,
  type ParticipantAccessStateReader,
} from "../domain/participant-home-resource.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import {
  parsePublicCampaignConfiguration,
  type PublicCampaignConfiguration,
} from "../domain/public-campaign-configuration.ts";
import { resolveAppOrigin, withAppOrigin } from "../http/app-origin.ts";
import { withRuntimeCapabilities } from "../http/runtime-capabilities.ts";
import { withRuntimeCampaign } from "../http/runtime-campaign.ts";
import { withRuntimeOwner } from "../http/runtime-owner.ts";
import { withRuntimeParticipantAccess } from "../http/runtime-participant.ts";
import {
  withRuntimeCampaignPreview,
  type RuntimeCampaignPreview,
} from "../http/runtime-preview.ts";
import type { PublicCampaignPresentationReader } from "../repositories/in-memory-campaign-repository.ts";
import type {
  ApplicationFetcher,
  ApplicationRouteContext,
  ApplicationRouteHandler,
  AuthenticatedActor,
  ImageFetcher,
  InvestorAppEnv,
  WorkerExecutionContext,
} from "./contracts.ts";
import type {
  ApplicationRuntimeDeploymentCapability,
  CampaignWorkspaceDeploymentCapability,
} from "./deployment-capabilities.ts";
import { hasHostedAittaDBApplicationRuntimeValues } from "./hosted-application-configuration.ts";
import {
  createApplicationRouteDispatcher,
  dispatchApplicationRoute,
} from "./routes/application.ts";
import {
  createOwnerIndicationModerationRouteHandler,
  type OwnerIndicationModerationRouteDependencies,
} from "./routes/owner-indication-moderation.ts";
import { createOwnerCampaignEditorRouteHandler } from "./routes/owner-campaign-editor.ts";
import { createOwnerInitialSetupRouteHandler } from "./routes/owner-initial-setup.ts";
import { createOwnerRouteHandler } from "./routes/owner.ts";
import {
  createOwnerPackageRouteHandler,
  type OwnerPackageRouteDependencies,
} from "./routes/owner-package.ts";
import {
  createFounderInterestRouteHandler,
  createInvestmentInterestRouteHandler,
  createParticipantRouteHandler,
  type FounderInterestRouteDependencies,
  type InvestmentInterestRouteDependencies,
} from "./routes/participant.ts";
import {
  createOwnerOAuthProofRouteHandler,
  type OwnerOAuthProofRouteDependencies,
} from "./routes/owner-oauth-proof.ts";
import {
  createOwnerReviewExportRouteHandler,
  type OwnerReviewExportRouteDependencies,
} from "./routes/owner-review-exports.ts";
import { handlePublicRoutes } from "./routes/public.ts";

export type ApplicationWorkerDependencies = Readonly<{
  fetchApplication: ApplicationFetcher;
  fetchOptimizedImage: ImageFetcher;
  dispatchRoute?: ApplicationRouteHandler;
  ownerPackage?: OwnerPackageRouteDependencies;
  ownerIndicationModeration?: OwnerIndicationModerationRouteDependencies;
  ownerReviewExports?: OwnerReviewExportRouteDependencies;
  participantFounderInterest?: FounderInterestRouteDependencies;
  participantInvestmentInterests?: InvestmentInterestRouteDependencies;
  participantAccessReader?: ParticipantAccessStateReader;
  ownerOAuthProof?: OwnerOAuthProofRouteDependencies;
  resolveOwnerOAuthProof?: (
    env: InvestorAppEnv,
  ) => Promise<OwnerOAuthProofRouteDependencies | null | undefined>;
  applicationRuntime?: ApplicationRuntimeDeploymentCapability;
  resolveApplicationRuntime?: (
    env: InvestorAppEnv,
  ) => Promise<ApplicationRuntimeDeploymentCapability | null | undefined>;
  publicCampaignReader?: PublicCampaignPresentationReader;
  campaignWorkspace?: CampaignWorkspaceDeploymentCapability;
  resolveCampaignWorkspace?: () =>
    CampaignWorkspaceDeploymentCapability | null | undefined;
}>;

export function createApplicationWorker(
  dependencies: ApplicationWorkerDependencies,
): Readonly<{
  fetch(
    request: Request,
    env: InvestorAppEnv,
    context: WorkerExecutionContext,
  ): Promise<Response>;
}> {
  const ownerPackageAvailable = dependencies.dispatchRoute === undefined &&
    dependencies.ownerPackage !== undefined;
  const ownerIndicationModerationAvailable =
    dependencies.dispatchRoute === undefined &&
    dependencies.ownerIndicationModeration !== undefined;
  const ownerReviewExportsAvailable = dependencies.dispatchRoute === undefined &&
    dependencies.ownerReviewExports !== undefined;
  const participantFounderInterestAvailable =
    dependencies.dispatchRoute === undefined &&
    dependencies.participantFounderInterest !== undefined;
  const participantInvestmentInterestsAvailable =
    dependencies.dispatchRoute === undefined &&
    dependencies.participantInvestmentInterests !== undefined;
  return {
    async fetch(request, env, executionContext) {
      const url = new URL(request.url);
      const appOrigin = resolveAppOrigin(request.url, env.APP_BASE_URL);
      const resourceUrl = canonicalResourceUrl(url, appOrigin);
      const actor = authenticatedActor(request);
      const isOwner = isConfiguredOwner(actor?.email, env.OWNER_EMAIL);
      const applicationRuntime = await resolveApplicationRuntime(
        dependencies,
        env,
      );
      const ownerOAuthProof = dependencies.dispatchRoute === undefined
        ? await resolveOwnerOAuthProof(dependencies, env)
        : null;
      const ownerOAuthProofAvailable = ownerOAuthProof !== null;
      const campaignWorkspace = dependencies.dispatchRoute === undefined
        ? resolveCampaignWorkspace(dependencies, applicationRuntime, appOrigin)
        : null;
      const publicCampaign = await resolvePublicCampaign(
        campaignWorkspace?.publicReader ?? dependencies.publicCampaignReader,
        hasHostedAittaDBApplicationRuntimeValues(env)
          ? undefined
          : env.CAMPAIGN_CONFIG_JSON,
      );
      const campaign = isOwner && isOwnerPath(url.pathname) && campaignWorkspace
        ? await resolveOwnerCampaign(campaignWorkspace, publicCampaign)
        : publicCampaign;
      const participantAccess = await resolveParticipantAccess(
        actor,
        dependencies.participantAccessReader,
      );
      const renderEnvironment = applicationRenderEnvironment(env);
      const campaignEditorAvailable = campaignWorkspace !== null;
      const renderApplication: ApplicationRouteContext["renderApplication"] = (
        options = {},
      ) => {
        const preview = options.preview ?? null;
        const normalApplication = preview === null;
        return dependencies.fetchApplication(
          withRuntimeConfiguration(
            options.request ?? request,
            env,
            normalApplication ? participantAccess : null,
            Object.hasOwn(options, "campaign")
              ? options.campaign ?? null
              : campaign,
            {
              ownerPackageWorkspace: normalApplication && ownerPackageAvailable,
              ownerIndicationModeration:
                normalApplication && ownerIndicationModerationAvailable,
              ownerReviewExports:
                normalApplication && ownerReviewExportsAvailable,
              participantFounderInterest:
                normalApplication && participantFounderInterestAvailable,
              participantInvestmentInterests:
                normalApplication && participantInvestmentInterestsAvailable,
              ownerCampaignEditor:
                normalApplication && campaignEditorAvailable,
              ownerCampaignSetup:
                normalApplication && campaignEditorAvailable,
              ownerAittadbConnection:
                normalApplication && ownerOAuthProofAvailable,
            },
            preview,
          ),
          renderEnvironment,
          executionContext,
        );
      };

      const hasInjectedRoutes = ownerPackageAvailable ||
        ownerIndicationModerationAvailable ||
        ownerReviewExportsAvailable ||
        participantFounderInterestAvailable ||
        participantInvestmentInterestsAvailable ||
        campaignEditorAvailable ||
        ownerOAuthProofAvailable;
      const dispatchRoute = dependencies.dispatchRoute ??
        (hasInjectedRoutes
          ? createInjectedRouteDispatcher(
              dependencies,
              campaignWorkspace,
              ownerOAuthProof,
              {
                ownerPackageAvailable,
                ownerIndicationModerationAvailable,
                ownerReviewExportsAvailable,
                participantFounderInterestAvailable,
                participantInvestmentInterestsAvailable,
                campaignEditorAvailable,
                campaignSetupAvailable: campaignEditorAvailable,
                ownerOAuthProofAvailable,
              },
            )
          : dispatchApplicationRoute);

      const routeResponse = await dispatchRoute({
        request,
        url,
        resourceUrl,
        actor,
        isOwner,
        participantAccess,
        campaign,
        renderApplication,
      });
      if (routeResponse) return routeResponse;

      if (url.pathname === "/_vinext/image") {
        return dependencies.fetchOptimizedImage(request, renderEnvironment);
      }

      return renderApplication();
    },
  };
}

function applicationRenderEnvironment(
  env: InvestorAppEnv,
): Readonly<Pick<InvestorAppEnv, "ASSETS" | "IMAGES">> {
  return Object.freeze({
    ASSETS: env.ASSETS,
    IMAGES: env.IMAGES,
  });
}

type InjectedRouteAvailability = Readonly<{
  ownerPackageAvailable: boolean;
  ownerIndicationModerationAvailable: boolean;
  ownerReviewExportsAvailable: boolean;
  participantFounderInterestAvailable: boolean;
  participantInvestmentInterestsAvailable: boolean;
  campaignEditorAvailable: boolean;
  campaignSetupAvailable: boolean;
  ownerOAuthProofAvailable: boolean;
}>;

function createInjectedRouteDispatcher(
  dependencies: ApplicationWorkerDependencies,
  campaignWorkspace: CampaignWorkspaceDeploymentCapability | null,
  ownerOAuthProof: OwnerOAuthProofRouteDependencies | null,
  available: InjectedRouteAvailability,
): ApplicationRouteHandler {
  const issueCampaignOperationId = campaignWorkspace?.issueOperationId;
  return createApplicationRouteDispatcher({
    public: handlePublicRoutes,
    participant: createParticipantRouteHandler(
      [
        ...(dependencies.participantFounderInterest
          ? [createFounderInterestRouteHandler(
              dependencies.participantFounderInterest,
            )]
          : []),
        ...(dependencies.participantInvestmentInterests
          ? [createInvestmentInterestRouteHandler(
              dependencies.participantInvestmentInterests,
            )]
          : []),
      ],
      {
        founderInterest: available.participantFounderInterestAvailable,
        investmentInterests: available.participantInvestmentInterestsAvailable,
      },
    ),
    owner: createOwnerRouteHandler(
      [
        ...(dependencies.ownerPackage
          ? [createOwnerPackageRouteHandler(dependencies.ownerPackage)]
          : []),
        ...(dependencies.ownerIndicationModeration
          ? [createOwnerIndicationModerationRouteHandler(
              dependencies.ownerIndicationModeration,
            )]
          : []),
        ...(dependencies.ownerReviewExports
          ? [createOwnerReviewExportRouteHandler(
              dependencies.ownerReviewExports,
            )]
          : []),
        ...(campaignWorkspace
          ? [
              createOwnerInitialSetupRouteHandler({
                repository: campaignWorkspace.repository,
                checkPublicationReadiness:
                  campaignWorkspace.checkPublicationReadiness,
                mutationSession: campaignWorkspace.mutationSession,
                appOrigin: campaignWorkspace.appOrigin,
                ...(issueCampaignOperationId
                  ? {
                      issueOperationId: () =>
                        issueCampaignOperationId("setup"),
                    }
                  : {}),
                ...(campaignWorkspace.now ? { now: campaignWorkspace.now } : {}),
              }),
              createOwnerCampaignEditorRouteHandler(campaignWorkspace),
            ]
          : []),
        ...(ownerOAuthProof
          ? [createOwnerOAuthProofRouteHandler(ownerOAuthProof)]
          : []),
      ],
      {
        managePackage: available.ownerPackageAvailable,
        indicationModeration: available.ownerIndicationModerationAvailable,
        reviewExports: available.ownerReviewExportsAvailable,
        campaignEditor: available.campaignEditorAvailable,
        campaignSetup: available.campaignSetupAvailable,
        aittadbConnection: available.ownerOAuthProofAvailable,
      },
    ),
  });
}

async function resolveApplicationRuntime(
  dependencies: ApplicationWorkerDependencies,
  env: InvestorAppEnv,
): Promise<ApplicationRuntimeDeploymentCapability | null> {
  if (dependencies.applicationRuntime !== undefined) {
    return dependencies.applicationRuntime;
  }
  try {
    return await dependencies.resolveApplicationRuntime?.(env) ?? null;
  } catch {
    return null;
  }
}

async function resolveOwnerOAuthProof(
  dependencies: ApplicationWorkerDependencies,
  env: InvestorAppEnv,
): Promise<OwnerOAuthProofRouteDependencies | null> {
  if (dependencies.ownerOAuthProof !== undefined) {
    return dependencies.ownerOAuthProof;
  }
  try {
    return await dependencies.resolveOwnerOAuthProof?.(env) ?? null;
  } catch {
    return null;
  }
}

function canonicalResourceUrl(url: URL, appOrigin: string): string {
  return new URL(`${url.pathname}${url.search}`, `${appOrigin}/`).href;
}

function withRuntimeConfiguration(
  request: Request,
  env: InvestorAppEnv,
  participantAccess: AuthorizedParticipantAccess | null,
  campaign: PublicCampaignConfiguration | null,
  capabilities: Readonly<{
    ownerPackageWorkspace: boolean;
    ownerIndicationModeration: boolean;
    ownerReviewExports: boolean;
    participantFounderInterest: boolean;
    participantInvestmentInterests: boolean;
    ownerCampaignEditor: boolean;
    ownerCampaignSetup: boolean;
    ownerAittadbConnection: boolean;
  }>,
  preview: RuntimeCampaignPreview | null,
): Request {
  return withRuntimeCampaignPreview(
    withRuntimeCapabilities(
      withRuntimeParticipantAccess(
        withRuntimeCampaign(
          withRuntimeOwner(
            withAppOrigin(request, env.APP_BASE_URL),
            preview === null ? env.OWNER_EMAIL : undefined,
          ),
          campaign === null ? undefined : JSON.stringify(campaign),
        ),
        participantAccess,
      ),
      capabilities,
    ),
    preview,
  );
}

async function resolvePublicCampaign(
  reader: PublicCampaignPresentationReader | undefined,
  bootstrapConfiguration: string | undefined,
): Promise<PublicCampaignConfiguration | null> {
  if (reader === undefined) {
    return parsePublicCampaignConfiguration(bootstrapConfiguration);
  }
  try {
    return await reader.readPublishedCampaign();
  } catch {
    return null;
  }
}

async function resolveOwnerCampaign(
  workspace: CampaignWorkspaceDeploymentCapability,
  fallback: PublicCampaignConfiguration | null,
): Promise<PublicCampaignConfiguration | null> {
  try {
    return (await workspace.repository.readSetup())?.setup.publicCampaign ?? fallback;
  } catch {
    return fallback;
  }
}

function resolveCampaignWorkspace(
  dependencies: ApplicationWorkerDependencies,
  runtime: ApplicationRuntimeDeploymentCapability | null,
  appOrigin: string,
): CampaignWorkspaceDeploymentCapability | null {
  if (dependencies.campaignWorkspace) return dependencies.campaignWorkspace;
  try {
    const injected = dependencies.resolveCampaignWorkspace?.() ?? null;
    if (injected !== null) return injected;
    if (runtime === null) return null;
    return Object.freeze({
      repository: runtime.repositoryFactory.campaignRepository(),
      publicReader: runtime.repositoryFactory.publicCampaignReader(),
      checkPublicationReadiness: async () => runtime.publicationReady === true,
      mutationSession: runtime.mutationSession,
      appOrigin,
    });
  } catch {
    return null;
  }
}

function isOwnerPath(pathname: string): boolean {
  return pathname === "/owner" || pathname.startsWith("/owner/");
}

async function resolveParticipantAccess(
  actor: AuthenticatedActor | null,
  reader: ParticipantAccessStateReader | undefined,
): Promise<AuthorizedParticipantAccess | null> {
  if (actor === null || reader === undefined) return null;

  const account = parseParticipantAccount({
    subject: actor.userId,
    accountEmailLabel: actor.email,
  });
  if (!account.ok) return null;

  try {
    return authorizeParticipantAccess(
      account.value,
      await reader.read(account.value),
    );
  } catch {
    return null;
  }
}

function authenticatedActor(request: Request): AuthenticatedActor | null {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim();

  if (!userId || !email) return null;
  const subject = parseActorSubject(userId);
  if (!subject.ok) return null;

  return {
    userId: subject.value,
    email,
    displayName: email,
  };
}
