# Participant Communication Notices

Each campaign setup supplies two separate participant-facing notices. The
required process-email notice explains operational messages needed to register,
review, or administer an expression of interest. The optional marketing-consent
notice describes messages a participant may independently accept or decline.

Both notices are owner-managed private campaign policy. Investor App provides
no reusable text or campaign fallback. Each value is trimmed, bounded to 4,000
characters, and restricted to one line so the setup policy and registration
resource enforce the same input contract.

Changing either notice is a material campaign-policy change. Immutable setup
history and owner backup data retain the exact configured values, while the
public campaign projection excludes both. The registration resource receives
them only through `participantRegistrationNoticesFromCampaignPolicy`.

Private campaign setup storage uses schema version 3. Development and test
fixtures migrate by supplying both values explicitly; legacy schema version 2
records fail closed. No production migration is required until AittaDB campaign
persistence is composed and enabled.
