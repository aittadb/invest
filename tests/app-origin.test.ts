import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_ORIGIN_HEADER,
  resolveAppOrigin,
  withAppOrigin,
} from "../http/app-origin.ts";

test("configured app origins are normalized independently per deployment", () => {
  assert.equal(
    resolveAppOrigin("https://generated-host.example/path", "https://invest.example.com/"),
    "https://invest.example.com",
  );
  assert.equal(
    resolveAppOrigin("https://generated-host.example/path", "https://founders.example.net"),
    "https://founders.example.net",
  );
});

test("missing or invalid app origins fall back to the request origin", () => {
  const requestUrl = "https://runtime.example/path?view=public";

  assert.equal(resolveAppOrigin(requestUrl), "https://runtime.example");
  assert.equal(resolveAppOrigin(requestUrl, "not a URL"), "https://runtime.example");
  assert.equal(
    resolveAppOrigin(requestUrl, "https://configured.example/path"),
    "https://runtime.example",
  );
  assert.equal(
    resolveAppOrigin(requestUrl, "javascript:alert(1)"),
    "https://runtime.example",
  );
});

test("the worker replaces client-supplied app-origin headers", () => {
  const request = new Request("https://runtime.example/", {
    headers: {
      [APP_ORIGIN_HEADER]: "https://spoofed.example",
    },
  });
  const enrichedRequest = withAppOrigin(
    request,
    "https://configured.example",
  );

  assert.equal(
    enrichedRequest.headers.get(APP_ORIGIN_HEADER),
    "https://configured.example",
  );
});
