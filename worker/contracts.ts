import type { PublicCampaignConfiguration } from "../domain/public-campaign-configuration.ts";
import type { SanitizedPublicInvestmentAggregate } from "../domain/investment-aggregate.ts";
import type {
  AuthorizedParticipantAccess,
} from "../domain/participant-home-resource.ts";
import type { RuntimeCampaignPreview } from "../http/runtime-preview.ts";
import type { D1OAuthProofDatabase } from "../repositories/d1-oauth-proof-store.ts";

export interface InvestorAppEnv {
  APP_BASE_URL?: string;
  AITTADB_OAUTH_ISSUER?: string;
  AITTADB_OAUTH_TRANSPORT_ORIGIN?: string;
  AITTADB_OAUTH_CLIENT_ID?: string;
  AITTADB_OAUTH_CLIENT_SECRET?: string;
  AITTADB_OAUTH_CALLBACK_URI?: string;
  AITTADB_OAUTH_STORAGE_SCOPES?: string;
  AITTADB_OAUTH_TRANSACTION_KEY?: string;
  AITTADB_OAUTH_CSRF_KEY?: string;
  AITTADB_STORAGE_ISSUER?: string;
  AITTADB_STORAGE_TRANSPORT_ORIGIN?: string;
  AITTADB_STORAGE_ENTRY_HREF?: string;
  AITTADB_STORAGE_CLIENT_ID?: string;
  AITTADB_STORAGE_CLIENT_SECRET?: string;
  AITTADB_STORAGE_SCOPES?: string;
  BROWSER_MUTATION_SESSION_KEY?: string;
  OWNER_INDICATION_REVIEW_KEY?: string;
  DEPLOYMENT_PUBLICATION_READY?: string;
  CAMPAIGN_CONFIG_JSON?: string;
  OWNER_EMAIL?: string;
  OAUTH_PROOF_DB?: D1OAuthProofDatabase;
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

export type ApplicationRenderEnvironment = Readonly<
  Pick<InvestorAppEnv, "ASSETS" | "IMAGES">
>;

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export type AuthenticatedActor = Readonly<{
  userId: string;
  email: string;
  displayName: string;
}>;

export type ApplicationRouteContext = Readonly<{
  request: Request;
  url: URL;
  resourceUrl: string;
  actor: AuthenticatedActor | null;
  isOwner: boolean;
  participantAccess: AuthorizedParticipantAccess | null;
  campaign: PublicCampaignConfiguration | null;
  publicAggregate?: SanitizedPublicInvestmentAggregate | null;
  renderApplication(
    options?: Readonly<{
      request?: Request;
      campaign?: PublicCampaignConfiguration | null;
      publicAggregate?: SanitizedPublicInvestmentAggregate | null;
      preview?: RuntimeCampaignPreview | null;
    }>,
  ): Promise<Response>;
}>;

export type ApplicationRouteHandler = (
  context: ApplicationRouteContext,
) => Promise<Response | null>;

export type ApplicationFetcher = (
  request: Request,
  env: ApplicationRenderEnvironment,
  context: WorkerExecutionContext,
) => Promise<Response>;

export type ImageFetcher = (
  request: Request,
  env: ApplicationRenderEnvironment,
) => Promise<Response>;
