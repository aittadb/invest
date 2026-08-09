import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const path = new URL("../.openai/hosting.json", import.meta.url);
let configuration;

try {
  configuration = JSON.parse(readFileSync(path, "utf8"));
} catch {
  assert.fail("Create a local .openai/hosting.json before packaging for Sites");
}

assert.match(
  configuration.project_id ?? "",
  /^appgprj_[A-Za-z0-9]+$/,
  "The active Sites binding must contain the exact project_id returned by Sites",
);
