import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_PACKAGE_WORKSPACE_HEADER,
  hasOwnerPackageWorkspace,
  withRuntimeCapabilities,
} from "../http/runtime-capabilities.ts";

test("the Worker replaces client-supplied package workspace availability", () => {
  const spoofed = new Request("https://campaign.example/owner", {
    headers: { [OWNER_PACKAGE_WORKSPACE_HEADER]: "available" },
  });
  const unavailable = withRuntimeCapabilities(spoofed, {
    ownerPackageWorkspace: false,
  });
  assert.equal(unavailable.headers.get(OWNER_PACKAGE_WORKSPACE_HEADER), null);
  assert.equal(hasOwnerPackageWorkspace("AVAILABLE"), false);

  const available = withRuntimeCapabilities(spoofed, {
    ownerPackageWorkspace: true,
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
});
