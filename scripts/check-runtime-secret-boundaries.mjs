import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { parseActiveSitesHostingConfiguration } from "./sites-hosting-config.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRODUCTION_ROOTS = [
  "app",
  "build",
  "db/migrations",
  "domain",
  "http",
  "repositories",
  "services",
  "worker",
  "public",
];
const BUILD_ROOT = "dist";
const ENV_EXAMPLE = ".env.example";
const ACTIVE_HOSTING_PATH = ".openai/hosting.json";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_ARCHIVE_LIST_BYTES = 4 * 1024 * 1024;

// Tests inject these exact values through runtime-only configuration. They must
// never reach release inputs, generated artifacts, or response material. Keep
// this scanner outside the production roots that receive the fixed values.
const SYNTHETIC_CANARIES = Object.freeze([
  Object.freeze({
    kind: "credential",
    value: "TASK111_SyntheticCredential_Canary_7w9L3vX2",
  }),
  Object.freeze({
    kind: "bearer token",
    value: "TASK111.SyntheticBearerToken.Canary.4nQ8xL2pV7sK9mR5",
  }),
  Object.freeze({
    kind: "client secret",
    value: "TASK111_SyntheticClientSecret_8pL4rN7vK2xQ5mC9",
  }),
  Object.freeze({
    kind: "mutation key",
    value: "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s",
  }),
  Object.freeze({
    kind: "owner review key",
    value: "r7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7w",
  }),
  Object.freeze({
    kind: "production identity",
    value: "Task111-Private-Owner@Identity.Example.Test",
  }),
  Object.freeze({
    kind: "private environment value",
    value: "https://task111-private-runtime.example.test",
  }),
]);

const ACTIVE_ARTIFACT_PATTERNS = Object.freeze([
  Object.freeze({ label: "aittadb.com hostname", pattern: /aittadb\.com/giu }),
  Object.freeze({ label: "chatgpt.site hostname", pattern: /chatgpt\.site/giu }),
  Object.freeze({ label: "iki.fi identity", pattern: /@iki\.fi/giu }),
  Object.freeze({
    label: "heusalagroup.fi identity",
    pattern: /@heusalagroup\.fi/giu,
  }),
]);
const PRIVATE_REPOSITORY_IDENTITY_PATTERNS = Object.freeze([
  Object.freeze({ label: "iki.fi identity", pattern: /@iki\.fi/giu }),
  Object.freeze({
    label: "heusalagroup.fi identity",
    pattern: /@heusalagroup\.fi/giu,
  }),
]);
const HIGH_CONFIDENCE_CREDENTIAL_PATTERNS = Object.freeze([
  Object.freeze({
    label: "known credential format",
    pattern:
      /(?:github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})/gu,
  }),
  Object.freeze({
    label: "private key material",
    pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/gu,
  }),
  Object.freeze({
    label: "credential-bearing URL",
    pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/gu,
  }),
]);

const TEXT_EXTENSIONS = new Set([
  "",
  ".css",
  ".cjs",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".map",
  ".md",
  ".mjs",
  ".mts",
  ".sh",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const LITERAL_ASSIGNMENT =
  /([A-Za-z_$][\w$-]{0,127})\s*(?::|=(?!=))\s*(["'`])((?:\\[\s\S]|(?!\2)[^\\\r\n])*)\2/gu;
const QUOTED_PROPERTY_ASSIGNMENT =
  /(["'])([A-Za-z_$][\w$-]{0,127})\1\s*:\s*(["'`])((?:\\[\s\S]|(?!\3)[^\\\r\n])*)\3/gu;
const ENVIRONMENT_DEFAULT =
  /(?:process\.env|import\.meta\.env|environment|env)(?:\.([A-Za-z_$][\w$]*)|\s*\[\s*(["'])([A-Za-z_$][\w$]*)\2\s*\])\s*(?:\?\?|\|\|)\s*(["'`])((?:\\[\s\S]|(?!\4)[^\\\r\n])*)\4/gu;

const findings = [];
const findingKeys = new Set();
const scannedFiles = new Set();
let options = Object.freeze({ scanPath: null, archivePath: null });
let suppliedCanaries = Object.freeze([]);

try {
  options = parseArguments(process.argv.slice(2));
  suppliedCanaries = loadSuppliedCanaries();
  if (options.scanPath !== null) {
    scanExternalPath(options.scanPath, suppliedCanaries);
  } else {
    scanTrackedRepository(suppliedCanaries);
    for (const root of PRODUCTION_ROOTS) scanTree(root, SYNTHETIC_CANARIES);
    if (existsSync(join(PROJECT_ROOT, BUILD_ROOT))) {
      scanTree(BUILD_ROOT, [...SYNTHETIC_CANARIES, ...suppliedCanaries]);
    }
    scanEnvironmentExample();
  }

  const archivePath = options.archivePath ?? process.env.SITES_ARCHIVE_PATH ?? null;
  if (archivePath !== null && archivePath !== "") {
    scanArchive(resolve(archivePath), [...SYNTHETIC_CANARIES, ...suppliedCanaries]);
  }
} catch {
  addFinding("release-boundary", 0, "inspection failed closed");
}

if (findings.length > 0) {
  console.error(`Runtime secret boundary failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line}:${finding.column} ${finding.rule}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Runtime secret boundary is clean (${scannedFiles.size} release files and ${ENV_EXAMPLE})`,
  );
}

function parseArguments(argumentsList) {
  let scanPath = null;
  let archivePath = null;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--scan-path" && scanPath === null) {
      scanPath = requiredArgument(argumentsList[index + 1]);
      index += 1;
    } else if (argument === "--archive" && archivePath === null) {
      archivePath = requiredArgument(argumentsList[index + 1]);
      index += 1;
    } else {
      throw new Error("Invalid scanner arguments.");
    }
  }
  return Object.freeze({ scanPath, archivePath });
}

function requiredArgument(value) {
  if (typeof value !== "string" || value === "") {
    throw new Error("Missing scanner argument.");
  }
  return value;
}

function loadSuppliedCanaries() {
  const path = process.env.INVEST_SECRET_SCAN_VALUES_FILE;
  if (path === undefined || path === "") return Object.freeze([]);
  const resolvedPath = resolve(path);
  const stats = statSync(resolvedPath);
  if (
    !stats.isFile() ||
    (stats.mode & 0o077) !== 0 ||
    typeof process.getuid === "function" && stats.uid !== process.getuid()
  ) {
    throw new Error("Unsafe supplied canary file.");
  }
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32) {
    throw new Error("Invalid supplied canary file.");
  }
  const seen = new Set();
  return Object.freeze(parsed.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      Object.keys(entry).sort().join(",") !== "kind,value" ||
      typeof entry.kind !== "string" ||
      !/^[a-z][a-z0-9 _-]{0,63}$/u.test(entry.kind) ||
      typeof entry.value !== "string" ||
      entry.value.length < 12 ||
      entry.value.length > 2_048 ||
      seen.has(entry.value)
    ) {
      throw new Error("Invalid supplied canary file.");
    }
    seen.add(entry.value);
    return Object.freeze({ kind: entry.kind, value: entry.value });
  }));
}

function scanTrackedRepository(externalCanaries) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  for (const projectPath of output.split("\0").filter(Boolean).sort()) {
    if (isSensitiveTrackedPath(projectPath)) {
      addFinding(projectPath, 0, "tracks deployment-private runtime material");
    }
    const absolutePath = join(PROJECT_ROOT, projectPath);
    const bytes = readFileSync(absolutePath);
    const text = bytes.toString("utf8");
    scannedFiles.add(projectPath);
    scanExactCanaries(projectPath, text, externalCanaries);
    scanPatterns(projectPath, text, PRIVATE_REPOSITORY_IDENTITY_PATTERNS,
      "contains private");
    scanRepositoryCredentialPatterns(projectPath, text);
    if (isReleaseInputPath(projectPath) && isTextFile(projectPath, bytes)) {
      if (projectPath !== "scripts/check-runtime-secret-boundaries.mjs") {
        scanExactCanaries(projectPath, text, SYNTHETIC_CANARIES);
        scanPatterns(projectPath, text, ACTIVE_ARTIFACT_PATTERNS,
          "contains active");
      }
      scanCommittedSecretAssignments(projectPath, text);
    }
  }
}

function isSensitiveTrackedPath(path) {
  const basename = path.split("/").at(-1) ?? path;
  return path === ACTIVE_HOSTING_PATH ||
    (/^\.env(?:\.|$)/u.test(basename) && path !== ENV_EXAMPLE) ||
    /^\.dev\.vars(?:\.|$)/u.test(basename) ||
    /(?:^|\/)(?:credentials?|secrets?)(?:\.[^/]*)?$/iu.test(path) ||
    /\.(?:key|p12|pfx|pem)$/iu.test(path);
}

function isReleaseInputPath(path) {
  if (
    path.startsWith("tests/") ||
    path.startsWith("docs/") ||
    path.endsWith(".md")
  ) return false;
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) ||
    path === ENV_EXAMPLE;
}

function scanTree(root, canaries) {
  const absoluteRoot = join(PROJECT_ROOT, root);
  if (!existsSync(absoluteRoot)) return;
  for (const absolutePath of filesBelow(absoluteRoot)) {
    const projectPath = portablePath(relative(PROJECT_ROOT, absolutePath));
    scanReleaseFile(projectPath, readFileSync(absolutePath), canaries);
  }
}

function scanExternalPath(path, canaries) {
  const absolutePath = resolve(path);
  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    scanReleaseFile(portablePath(relative(PROJECT_ROOT, absolutePath)),
      readFileSync(absolutePath), [...SYNTHETIC_CANARIES, ...canaries]);
    return;
  }
  if (!stats.isDirectory()) throw new Error("Unsupported scan path.");
  for (const file of filesBelow(absolutePath)) {
    scanReleaseFile(portablePath(relative(absolutePath, file)), readFileSync(file),
      [...SYNTHETIC_CANARIES, ...canaries]);
  }
}

function scanReleaseFile(path, bytes, canaries) {
  const text = bytes.toString("utf8");
  scannedFiles.add(path);
  scanExactCanaries(path, text, canaries);
  scanPatterns(path, text, ACTIVE_ARTIFACT_PATTERNS, "contains active");
  scanPatterns(path, text, HIGH_CONFIDENCE_CREDENTIAL_PATTERNS, "contains");
  if (isTextFile(path, bytes)) scanCommittedSecretAssignments(path, text);
  if (isActiveHostingManifest(path)) {
    try {
      parseActiveSitesHostingConfiguration(text);
    } catch {
      addFinding(path, 0, "contains an invalid active hosting manifest");
    }
  }
}

function scanArchive(archivePath, canaries) {
  const archiveStats = statSync(archivePath);
  if (!archiveStats.isFile() || archiveStats.size > MAX_ARCHIVE_BYTES) {
    throw new Error("Invalid archive.");
  }
  const archiveBytes = readFileSync(archivePath);
  const expandedArchive = gunzipSync(archiveBytes, {
    maxOutputLength: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  }).toString("utf8");
  scanReleaseMetadata("archive:raw-metadata", expandedArchive, canaries);
  const entries = execFileSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
  }).split("\n").filter(Boolean);
  const verbose = execFileSync("tar", ["-tvzf", archivePath], {
    encoding: "utf8",
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
  }).split("\n").filter(Boolean);
  if (
    entries.length < 1 ||
    entries.length > MAX_ARCHIVE_ENTRIES ||
    entries.length !== verbose.length
  ) {
    throw new Error("Invalid archive.");
  }
  const seenEntries = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    scanReleaseMetadata(`archive:name:${index}`, entry, canaries);
    scanReleaseMetadata(`archive:metadata:${index}`, verbose[index] ?? "", canaries);
    if (seenEntries.has(entry)) {
      addFinding(`archive:${entry}`, 0, "duplicates an archive entry");
      continue;
    }
    seenEntries.add(entry);
    if (!isSafeArchiveEntry(entry)) {
      addFinding("sites-archive", 0, "contains an unsafe archive entry");
      continue;
    }
    const kind = verbose[index]?.at(0);
    if (entry.endsWith("/")) {
      if (kind !== "d") addFinding(`archive:${entry}`, 0, "has an unsafe type");
      continue;
    }
    if (kind !== "-") {
      addFinding(`archive:${entry}`, 0, "has an unsafe type");
      continue;
    }
    const bytes = execFileSync("tar", ["-xOzf", archivePath, entry], {
      encoding: "buffer",
      maxBuffer: MAX_ARCHIVE_BYTES,
    });
    scanReleaseFile(`archive:${entry}`, bytes, canaries);
  }
}

function scanReleaseMetadata(path, text, canaries) {
  scanExactCanaries(path, text, canaries);
  scanPatterns(path, text, ACTIVE_ARTIFACT_PATTERNS, "contains active");
  scanPatterns(path, text, HIGH_CONFIDENCE_CREDENTIAL_PATTERNS, "contains");
}

function isSafeArchiveEntry(entry) {
  if (
    entry === "" ||
    isAbsolute(entry) ||
    entry.includes("\\") ||
    entry.startsWith("-") ||
    !/^[A-Za-z0-9._~/-]+$/u.test(entry) ||
    !entry.startsWith("dist/") && entry !== "dist"
  ) return false;
  const parts = entry.split("/");
  return parts.every((part) => part !== ".." && part !== ".");
}

function isActiveHostingManifest(path) {
  const releasePath = path.startsWith("archive:") ? path.slice(8) : path;
  return releasePath === "dist/.openai/hosting.json" ||
    releasePath.endsWith("/dist/.openai/hosting.json");
}

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
    else addFinding(portablePath(relative(PROJECT_ROOT, path)), 0,
      "contains an unsupported filesystem entry");
  }
  return files;
}

function scanEnvironmentExample() {
  const envExamplePath = join(PROJECT_ROOT, ENV_EXAMPLE);
  if (!existsSync(envExamplePath)) {
    addFinding(ENV_EXAMPLE, 0, "missing inert runtime example");
    return;
  }
  const envText = readFileSync(envExamplePath, "utf8");
  scannedFiles.add(ENV_EXAMPLE);
  scanExactCanaries(ENV_EXAMPLE, envText, SYNTHETIC_CANARIES);
  scanPatterns(ENV_EXAMPLE, envText, ACTIVE_ARTIFACT_PATTERNS,
    "contains active");
  const lines = envText.split(/\r?\n/u);
  for (let offset = 0, index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u,
    );
    if (match) {
      const [, name, rawValue] = match;
      const value = unquoteEnvironmentValue(rawValue.trim());
      if (
        isSecretBearingName(name) &&
        value !== "" &&
        !isInertExampleValue(value)
      ) {
        addFinding(ENV_EXAMPLE, offset,
          `contains an active-looking value for ${name}`, envText);
      } else if (
        !isInertExampleValue(value) &&
        looksHighConfidenceSecret(value)
      ) {
        addFinding(ENV_EXAMPLE, offset,
          `contains an active-looking secret value in ${name}`, envText);
      }
    }
    offset += line.length + 1;
  }
}

function scanExactCanaries(path, text, canaries) {
  for (const canary of canaries) {
    let index = text.indexOf(canary.value);
    while (index !== -1) {
      addFinding(path, index, `contains supplied ${canary.kind}`, text);
      index = text.indexOf(canary.value, index + canary.value.length);
    }
  }
}

function scanPatterns(path, text, patterns, prefix) {
  for (const boundary of patterns) {
    boundary.pattern.lastIndex = 0;
    for (const match of text.matchAll(boundary.pattern)) {
      addFinding(path, match.index, `${prefix} ${boundary.label}`, text);
    }
  }
}

function scanRepositoryCredentialPatterns(path, text) {
  for (const boundary of HIGH_CONFIDENCE_CREDENTIAL_PATTERNS) {
    boundary.pattern.lastIndex = 0;
    for (const match of text.matchAll(boundary.pattern)) {
      if (isApprovedSyntheticCredentialFixture(path, boundary.label, match[0])) {
        continue;
      }
      addFinding(path, match.index, `contains ${boundary.label}`, text);
    }
  }
}

function isApprovedSyntheticCredentialFixture(path, label, value) {
  const expected = ["https://user", "password@assets.example"].join(":");
  return path === "tests/public-campaign-configuration.test.ts" &&
    label === "credential-bearing URL" &&
    value === expected;
}

function scanCommittedSecretAssignments(path, text) {
  LITERAL_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(LITERAL_ASSIGNMENT)) {
    const [, name, , value] = match;
    if (
      isSecretBearingName(name) &&
      !isGeneratedFrameworkNonce(path, name, value) &&
      looksCommitted(name, value)
    ) {
      addFinding(path, match.index, "contains a committed secret assignment", text);
    }
  }

  QUOTED_PROPERTY_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(QUOTED_PROPERTY_ASSIGNMENT)) {
    const [, , name, , value] = match;
    if (
      isSecretBearingName(name) &&
      !isGeneratedFrameworkNonce(path, name, value) &&
      looksCommitted(name, value)
    ) {
      addFinding(path, match.index, "contains a committed secret property", text);
    }
  }

  ENVIRONMENT_DEFAULT.lastIndex = 0;
  for (const match of text.matchAll(ENVIRONMENT_DEFAULT)) {
    const name = match[1] ?? match[3];
    const value = match[5];
    if (isSecretBearingName(name) && looksCommitted(name, value)) {
      addFinding(path, match.index, "contains a committed secret default", text);
    }
  }
}

function isSecretBearingName(name) {
  const normalized = name.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return normalized === "secret" ||
    normalized === "password" ||
    normalized === "token" ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    /(?:api|auth|access|refresh|bearer|private|session|csrf|mutation|transaction|encryption|signing)(?:key|token)$/u.test(
      normalized,
    );
}

function looksCommitted(name, rawValue) {
  const value = decodeSimpleEscapes(rawValue).trim();
  if (isInertExampleValue(value) || looksLikeEnvironmentVariableName(value)) {
    return false;
  }
  if (looksHighConfidenceSecret(value)) return true;

  const normalizedName = name.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  const specificallySecret = normalizedName.endsWith("secret") ||
    normalizedName.endsWith("password") ||
    /(?:api|private|session|csrf|mutation|transaction|encryption|signing)key$/u.test(
      normalizedName,
    );
  return specificallySecret && value.length >= 12 && !/\s/u.test(value);
}

function isGeneratedFrameworkNonce(path, name, value) {
  const releasePath = path.startsWith("archive:") ? path.slice(8) : path;
  return releasePath.startsWith("dist/server/") &&
    releasePath.endsWith("vinext-server.json") &&
    name === "prerenderSecret" &&
    /^[A-Fa-f0-9]{64}$/u.test(value);
}

function looksHighConfidenceSecret(value) {
  if (value === "" || /\s/u.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      return url.username !== "" || url.password !== "";
    } catch {
      return false;
    }
  }
  if (
    /^(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?|sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})$/u.test(
      value,
    )
  ) return true;
  if (/^[A-Fa-f0-9]{32,}$/u.test(value)) return true;
  if (/^[A-Za-z0-9_-]{24,}={0,2}$/u.test(value)) {
    return characterClassCount(value) >= 2 || uniqueRatio(value) >= 0.35;
  }
  return value.length >= 24 &&
    characterClassCount(value) >= 3 &&
    uniqueRatio(value) >= 0.35;
}

function isInertExampleValue(value) {
  return value === "" ||
    /^(?:<[^>]+>|\$\{[^}]+\}|(?:replace|example|dummy|fake|sample|test|your)(?:[-_].*)?|change-?me|not[-_]?configured|disabled|none|redacted|null|undefined)$/iu.test(
      value,
    );
}

function looksLikeEnvironmentVariableName(value) {
  return /^[A-Z][A-Z0-9_]{2,}$/u.test(value);
}

function characterClassCount(value) {
  return [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].reduce(
    (count, pattern) => count + Number(pattern.test(value)),
    0,
  );
}

function uniqueRatio(value) {
  return new Set(value).size / value.length;
}

function decodeSimpleEscapes(value) {
  return value.replace(/\\([\\"'`])/gu, "$1");
}

function unquoteEnvironmentValue(value) {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function isTextFile(path, bytes) {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) &&
    !bytes.subarray(0, 8_192).includes(0);
}

function addFinding(path, index, rule, text = "") {
  const key = `${path}\0${index}\0${rule}`;
  if (findingKeys.has(key)) return;
  findingKeys.add(key);
  const prefix = text.slice(0, Math.max(index, 0));
  const lines = prefix.split("\n");
  findings.push(Object.freeze({
    path,
    line: text === "" ? 1 : lines.length,
    column: text === "" ? 1 : (lines.at(-1)?.length ?? 0) + 1,
    rule,
  }));
}

function portablePath(path) {
  return path.split("\\").join("/");
}
