import assert from "node:assert/strict";
import test from "node:test";

import {
  isConfiguredOwner,
  normalizeOwnerEmail,
} from "../domain/owner-identity.ts";
import {
  OWNER_EMAIL_HEADER,
  withRuntimeOwner,
} from "../http/runtime-owner.ts";

test("owner email configuration is normalized and validated", () => {
  assert.equal(normalizeOwnerEmail(" Owner@Example.com "), "owner@example.com");
  assert.equal(normalizeOwnerEmail("missing-at.example.com"), null);
  assert.equal(normalizeOwnerEmail("two@@example.com"), null);
  assert.equal(normalizeOwnerEmail(""), null);
});

test("owner authorization requires matching configured and actor emails", () => {
  assert.equal(isConfiguredOwner("OWNER@example.com", "owner@example.com"), true);
  assert.equal(isConfiguredOwner("other@example.com", "owner@example.com"), false);
  assert.equal(isConfiguredOwner("owner@example.com", undefined), false);
});

test("the worker replaces client-supplied owner configuration", () => {
  const request = new Request("https://campaign.example/", {
    headers: { [OWNER_EMAIL_HEADER]: "spoofed@example.com" },
  });

  assert.equal(
    withRuntimeOwner(request, "owner@example.com").headers.get(OWNER_EMAIL_HEADER),
    "owner@example.com",
  );
  assert.equal(
    withRuntimeOwner(request, "invalid").headers.get(OWNER_EMAIL_HEADER),
    null,
  );
});
