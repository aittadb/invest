import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseActiveSitesHostingConfiguration } from "./sites-hosting-config.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_ROOT = join(PROJECT_ROOT, "dist");
const HOSTING_PATH = join(DIST_ROOT, ".openai", "hosting.json");
const WORKER_PATH = join(DIST_ROOT, "server", "index.js");
const ARCHIVE_PATH = join(PROJECT_ROOT, "work", "sites-package.tar.gz");

try {
  if (!existsSync(WORKER_PATH) || !existsSync(HOSTING_PATH)) {
    throw new Error("The built Sites release is incomplete");
  }
  parseActiveSitesHostingConfiguration(readFileSync(HOSTING_PATH, "utf8"));
  mkdirSync(dirname(ARCHIVE_PATH), { recursive: true });
  rmSync(ARCHIVE_PATH, { force: true });
  execFileSync("tar", [
    "-czf",
    ARCHIVE_PATH,
    "-C",
    PROJECT_ROOT,
    "dist",
  ]);
  chmodSync(ARCHIVE_PATH, 0o600);
  if ((statSync(ARCHIVE_PATH).mode & 0o077) !== 0) {
    throw new Error("Sites archive permissions are unsafe");
  }
  const entries = execFileSync("tar", ["-tzf", ARCHIVE_PATH], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }).split("\n").filter(Boolean);
  for (const required of [
    "dist/server/index.js",
    "dist/.openai/hosting.json",
  ]) {
    if (!entries.includes(required)) throw new Error("Sites archive is incomplete");
  }
  console.log(ARCHIVE_PATH);
} catch {
  console.error("Sites archive packaging failed");
  process.exitCode = 1;
}
