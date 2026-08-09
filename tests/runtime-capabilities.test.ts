import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_INDICATION_MODERATION_HEADER,
  OWNER_PACKAGE_WORKSPACE_HEADER,
  hasOwnerIndicationModeration,
  hasOwnerPackageWorkspace,
  withRuntimeCapabilities,
} from "../http/runtime-capabilities.ts";

test("the Worker replaces client-supplied owner feature availability", () => {
  const spoofed = new Request("https://campaign.example/owner", {
    headers: {
      [OWNER_PACKAGE_WORKSPACE_HEADER]: "available",
      [OWNER_INDICATION_MODERATION_HEADER]: "available",
    },
  });
  const unavailable = withRuntimeCapabilities(spoofed, {
    ownerPackageWorkspace: false,
    ownerIndicationModeration: false,
  });
  assert.equal(unavailable.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER), null);
  assert.equal(unavailable.headers.get(OWNER_INDICATION_MODERATION_HEADER), null);
  assert.equal(hasOwnerPackageWorkspace("AVAILABLE"), false);
  assert.equal(hasOwnerIndicationModeration("AVAILABLE"), false);

  const available = withRuntimeCapabilities(spoofed, {
    ownerPackageWorkspace: true,
    ownerIndicationModeration: true,
  });
  assert.equal(
    available.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER),
    "available",
  );
  assert.equal(
    hasOwnerPackageWorkspace(
      available.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER),
    ),
    true,
  );
  assert.equal(
    hasOwnerIndicationModeration(
      available.headers.get(OWNER_INDICATION_MODERATION_HEADER),
    ),
    true,
  );
});
