import {
  createParticipantRegistrationNoticeEvidence,
  type ParticipantRegistrationNoticeEvidence,
  type ParticipantRegistrationNotices,
} from "../../domain/participant-registration-notice-evidence.ts";

export const TEST_PROCESS_EMAIL_NOTICE =
  "Required process messages concern registration and campaign participation.";
export const TEST_MARKETING_NOTICE =
  "Optional marketing messages are separate from required process messages.";

export function testParticipantRegistrationNoticeEvidence(
  campaignRevision = 1,
  notices: ParticipantRegistrationNotices = Object.freeze({
    processEmail: TEST_PROCESS_EMAIL_NOTICE,
    marketing: TEST_MARKETING_NOTICE,
  }),
): ParticipantRegistrationNoticeEvidence {
  return createParticipantRegistrationNoticeEvidence(
    campaignRevision,
    notices,
  );
}
