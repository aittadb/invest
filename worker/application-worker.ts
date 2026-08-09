import { isConfiguredOwner } from "../domain/owner-identity.ts";
import { parsePublicCampaignConfiguration } from "../domain/public-campaign-configuration.ts";
import { withAppOrigin } from "../http/app-origin.ts";
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
      const actor = authenticatedActor(request);
      const isOwner = isConfiguredOwner(actor?.email, env.OWNER_EMAIL);
      const campaign = parsePublicCampaignConfiguration(
        env.CAMPAIGN_CONFIG_JSON,
      );
      const renderApplication = () =>
        dependencies.fetchApplication(
          withRuntimeConfiguration(request, env),
          env,
          executionContext,
        );

      const routeResponse = await dispatchRoute({
        request,
        url,
        actor,
        isOwner,
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

function withRuntimeConfiguration(
  request: Request,
  env: InvestorAppEnv,
): Request {
  return withRuntimeCampaign(
    withRuntimeOwner(withAppOrigin(request, env.APP_BASE_URL), env.OWNER_EMAIL),
    env.CAMPAIGN_CONFIG_JSON,
  );
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
