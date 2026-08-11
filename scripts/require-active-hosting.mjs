import { readFileSync } from "node:fs";

import { parseActiveSitesHostingConfiguration } from "./sites-hosting-config.mjs";

const path = new URL("../.openai/hosting.json", import.meta.url);

try {
  parseActiveSitesHostingConfiguration(readFileSync(path, "utf8"));
} catch {
  console.error(
    "Create an ignored .openai/hosting.json with exactly project_id, d1, and r2 before packaging for Sites",
  );
  process.exitCode = 1;
}
