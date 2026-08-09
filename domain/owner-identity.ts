const MAX_EMAIL_LENGTH = 254;

export function normalizeOwnerEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();

  if (
    !normalized ||
    normalized.length > MAX_EMAIL_LENGTH ||
    normalized.includes(" ") ||
    normalized.startsWith("@") ||
    normalized.endsWith("@") ||
    normalized.split("@").length !== 2
  ) {
    return null;
  }

  return normalized;
}

export function isConfiguredOwner(
  actorEmail: string | null | undefined,
  configuredOwnerEmail: string | null | undefined,
): boolean {
  const actor = normalizeOwnerEmail(actorEmail);
  const owner = normalizeOwnerEmail(configuredOwnerEmail);
  return actor !== null && owner !== null && actor === owner;
}
