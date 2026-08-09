import assert from "node:assert/strict";
import test from "node:test";

import { negotiateRepresentation } from "../http/content-negotiation.ts";

test("content negotiation defaults browsers and wildcards to HTML", () => {
  assert.deepEqual(negotiateRepresentation(null), { kind: "html" });
  assert.deepEqual(negotiateRepresentation("*/*"), { kind: "html" });
  assert.deepEqual(
    negotiateRepresentation("text/html,application/xhtml+xml,*/*;q=0.8"),
    { kind: "html" },
  );
  assert.deepEqual(negotiateRepresentation("text/x-component"), {
    kind: "html",
  });
});

test("content negotiation selects supported hypermedia JSON", () => {
  assert.deepEqual(negotiateRepresentation("application/json"), {
    kind: "hypermedia-json",
  });
  assert.deepEqual(
    negotiateRepresentation(
      'text/html;q=0.5, application/vnd.aittadb-invest+json; version="0.1";q=1',
    ),
    { kind: "hypermedia-json" },
  );
});

test("content negotiation rejects unsupported explicit versions and media", () => {
  assert.deepEqual(
    negotiateRepresentation(
      "application/vnd.aittadb-invest+json; version=1.0, text/html;q=0.8",
    ),
    { kind: "not-acceptable" },
  );
  assert.deepEqual(
    negotiateRepresentation("application/vnd.aittadb-invest+json"),
    { kind: "not-acceptable" },
  );
  assert.deepEqual(negotiateRepresentation("application/xml"), {
    kind: "not-acceptable",
  });
});
