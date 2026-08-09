import { isConfiguredOwner } from "../domain/owner-identity.ts";
import {
  authorizeParticipantAccess,
  type AuthorizedParticipantAccess,
  type ParticipantAccessStateReader,
} from "../domain/participant-home-resource.ts";
import { parseParticipantAccount } from "../domain/participant-profile.ts";
import { parsePublicCampaignConfiguration } from "../domain/public-campaign-configuration.ts";
import { resolveAppOrigin, withAppOrigin } from "../http/app-origin.ts";
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
import { dispatchApplicationRoute } from "./routes/application.ts";

export type ApplicationWorkerDependencies = Readonly<{
  fetchApplication: ApplicationFetcher;
  fetchOptimizedImage: ImageFetcher;
  dispatchRoute?: ApplicationRouteHandler;
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
  const dispatchRoute = dependencies.dispatchRoute ?? dispatchApplicationRoute;

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
          withRuntimeConfiguration(request, env, participantAccess),
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
): Request {
  return withRuntimeParticipantAccess(
    withRuntimeCampaign(
      withRuntimeOwner(withAppOrigin(request, env.APP_BASE_URL), env.OWNER_EMAIL),
      env.CAMPAIGN_CONFIG_JSON,
    ),
    participantAccess,
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

  return {
    userId,
    email,
    displayName: email,
  };
}
