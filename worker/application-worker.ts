import { isConfiguredOwner } from "../domain/owner-identity.ts";
import { parseActorSubject } from "../domain/foundation.ts";
import {
  authorizeParticipantAccess,
  type AuthorizedParticipantAccess,
  type ParticipantAccessStateReader,
} from "../domain/participant-home-resource.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import { parsePublicCampaignConfiguration } from "../domain/public-campaign-configuration.ts";
import { resolveAppOrigin, withAppOrigin } from "../http/app-origin.ts";
import { withRuntimeCapabilities } from "../http/runtime-capabilities.ts";
import { withRuntimeParticipantAccess } from "../http/runtime-participant.ts";
import { withRuntimeCampaign } from "../http/runtime-campaign.ts";
import { withRuntimeOwner } from "../http/runtime-owner.ts";
import type {
  ApplicationFetcher,
  ApplicationRouteHandler,
  AuthenticatedActor,
  ImageFetcher,
  InvestorAppEnv,
  WorkerExecutionContext,
} from "./contracts.ts";
import {
  createApplicationRouteDispatcher,
  dispatchApplicationRoute,
} from "./routes/application.ts";
import { handlePublicRoutes } from "./routes/public.ts";
import {
  createFounderInterestRouteHandler,
  createInvestmentInterestRouteHandler,
  createParticipantRouteHandler,
  type FounderInterestRouteDependencies,
  type InvestmentInterestRouteDependencies,
} from "./routes/participant.ts";
import { createOwnerRouteHandler } from "./routes/owner.ts";
import {
  createOwnerPackageRouteHandler,
  type OwnerPackageRouteDependencies,
} from "./routes/owner-package.ts";
import {
  createOwnerIndicationModerationRouteHandler,
  type OwnerIndicationModerationRouteDependencies,
} from "./routes/owner-indication-moderation.ts";
import {
  createOwnerOAuthProofRouteHandler,
  type OwnerOAuthProofRouteDependencies,
} from "./routes/owner-oauth-proof.ts";

export type ApplicationWorkerDependencies = Readonly<{
  fetchApplication: ApplicationFetcher;
  fetchOptimizedImage: ImageFetcher;
  dispatchRoute?: ApplicationRouteHandler;
  ownerPackage?: OwnerPackageRouteDependencies;
  ownerIndicationModeration?: OwnerIndicationModerationRouteDependencies;
  participantFounderInterest?: FounderInterestRouteDependencies;
  participantInvestmentInterests?: InvestmentInterestRouteDependencies;
  ownerOAuthProof?: OwnerOAuthProofRouteDependencies;
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
  const participantFounderInterestAvailable =
    dependencies.dispatchRoute === undefined &&
    dependencies.participantFounderInterest !== undefined;
  const participantInvestmentInterestsAvailable =
    dependencies.dispatchRoute === undefined &&
    dependencies.participantInvestmentInterests !== undefined;
  const ownerOAuthProofAvailable = dependencies.dispatchRoute === undefined &&
    dependencies.ownerOAuthProof !== undefined;
  const hasInjectedRoutes = ownerPackageAvailable ||
    ownerIndicationModerationAvailable ||
    participantFounderInterestAvailable ||
    participantInvestmentInterestsAvailable ||
    ownerOAuthProofAvailable;
  const dispatchRoute = dependencies.dispatchRoute ??
    (hasInjectedRoutes
      ? createApplicationRouteDispatcher({
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
              founderInterest: participantFounderInterestAvailable,
              investmentInterests: participantInvestmentInterestsAvailable,
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
              ...(dependencies.ownerOAuthProof
                ? [createOwnerOAuthProofRouteHandler(
                    dependencies.ownerOAuthProof,
                  )]
                : []),
            ],
            {
              managePackage: ownerPackageAvailable,
              indicationModeration: ownerIndicationModerationAvailable,
              aittadbConnection: ownerOAuthProofAvailable,
            },
          ),
        })
      : dispatchApplicationRoute);

  return {
    async fetch(request, env, executionContext) {
      const url = new URL(request.url);
      const resourceUrl = canonicalResourceUrl(
        url,
        resolveAppOrigin(request.url, env.APP_BASE_URL),
      );
      const actor = authenticatedActor(request);
      const isOwner = isConfiguredOwner(actor?.email, env.OWNER_EMAIL);
      const campaign = parsePublicCampaignConfiguration(
        env.CAMPAIGN_CONFIG_JSON,
      );
      const participantAccess = await resolveParticipantAccess(
        actor,
        env.PARTICIPANT_ACCESS,
      );
      const renderApplication = () =>
        dependencies.fetchApplication(
          withRuntimeConfiguration(
            request,
            env,
            participantAccess,
            ownerPackageAvailable,
            ownerIndicationModerationAvailable,
            participantFounderInterestAvailable,
            participantInvestmentInterestsAvailable,
            ownerOAuthProofAvailable,
          ),
          env,
          executionContext,
        );

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
        return dependencies.fetchOptimizedImage(request, env);
      }

      return renderApplication();
    },
  };
}

function canonicalResourceUrl(url: URL, appOrigin: string): string {
  return new URL(`${url.pathname}${url.search}`, `${appOrigin}/`).href;
}

function withRuntimeConfiguration(
  request: Request,
  env: InvestorAppEnv,
  participantAccess: AuthorizedParticipantAccess | null,
  ownerPackageWorkspaceAvailable: boolean,
  ownerIndicationModerationAvailable: boolean,
  participantFounderInterestAvailable: boolean,
  participantInvestmentInterestsAvailable: boolean,
  ownerOAuthProofAvailable: boolean,
): Request {
  return withRuntimeCapabilities(
    withRuntimeParticipantAccess(
      withRuntimeCampaign(
        withRuntimeOwner(
          withAppOrigin(request, env.APP_BASE_URL),
          env.OWNER_EMAIL,
        ),
        env.CAMPAIGN_CONFIG_JSON,
      ),
      participantAccess,
    ),
    {
      ownerPackageWorkspace: ownerPackageWorkspaceAvailable,
      ownerIndicationModeration: ownerIndicationModerationAvailable,
      participantFounderInterest: participantFounderInterestAvailable,
      participantInvestmentInterests: participantInvestmentInterestsAvailable,
      ownerAittadbConnection: ownerOAuthProofAvailable,
    },
  );
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
