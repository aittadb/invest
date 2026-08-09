import type { PublicCampaignConfiguration } from "../domain/public-campaign-configuration.ts";
import type {
  AuthorizedParticipantAccess,
  ParticipantAccessStateReader,
} from "../domain/participant-home-resource.ts";
import type { RuntimeCampaignPreview } from "../http/runtime-preview.ts";

export interface InvestorAppEnv {
  APP_BASE_URL?: string;
  CAMPAIGN_CONFIG_JSON?: string;
  OWNER_EMAIL?: string;
  PARTICIPANT_ACCESS?: ParticipantAccessStateReader;
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
  renderApplication(
    options?: Readonly<{
      request?: Request;
      campaign?: PublicCampaignConfiguration | null;
      preview?: RuntimeCampaignPreview | null;
    }>,
  ): Promise<Response>;
}>;

export type ApplicationRouteHandler = (
  context: ApplicationRouteContext,
) => Promise<Response | null>;

export type ApplicationFetcher = (
  request: Request,
  env: InvestorAppEnv,
  context: WorkerExecutionContext,
) => Promise<Response>;

export type ImageFetcher = (
  request: Request,
  env: InvestorAppEnv,
) => Promise<Response>;
