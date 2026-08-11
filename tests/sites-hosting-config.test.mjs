import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActiveSitesHostingConfiguration,
} from "../scripts/sites-hosting-config.mjs";

test("active Sites hosting configuration accepts only routing metadata", () => {
  assert.deepEqual(
    parseActiveSitesHostingConfiguration(JSON.stringify({
      project_id: "appgprj_Synthetic123",
      d1: "DB",
      r2: "BUCKET",
    })),
    {
      project_id: "appgprj_Synthetic123",
      d1: "DB",
      r2: "BUCKET",
    },
  );
  assert.deepEqual(
    parseActiveSitesHostingConfiguration(JSON.stringify({
      r2: null,
      project_id: "appgprj_Synthetic123",
      d1: null,
    })),
    {
      project_id: "appgprj_Synthetic123",
      d1: null,
      r2: null,
    },
  );
});

test("active Sites hosting configuration rejects private or ambiguous fields", () => {
  const invalid = [
    null,
    [],
    {},
    { project_id: "appgprj_Synthetic123", d1: null },
    {
      project_id: "appgprj_Synthetic123",
      d1: null,
      r2: null,
      owner: "private deployment value",
    },
    { project_id: "wrong", d1: null, r2: null },
    { project_id: "appgprj_Synthetic123", d1: "bad binding", r2: null },
    { project_id: "appgprj_Synthetic123", d1: null, r2: 1 },
    { project_id: "appgprj_Synthetic123", d1: "DATA", r2: "DATA" },
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseActiveSitesHostingConfiguration(JSON.stringify(value)),
      /active Sites hosting configuration is invalid/u,
    );
  }
  assert.throws(
    () => parseActiveSitesHostingConfiguration("not-json"),
    SyntaxError,
  );
  assert.throws(
    () => parseActiveSitesHostingConfiguration(
      '{"project_id":"private","project_id":"appgprj_Synthetic123","d1":null,"r2":null}',
    ),
    /active Sites hosting configuration is invalid/u,
  );
});
