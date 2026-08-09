import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join, relative } from "node:path";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRODUCTION_ROOTS = [
  "app",
  "domain",
  "http",
  "repositories",
  "services",
  "worker",
  "public",
];
const BUILD_ROOT = "dist";
const ENV_EXAMPLE = ".env.example";

// Tests may inject these exact values. They must never reach production source
// or generated artifacts. Keep the scanner itself outside the scanned roots.
const SYNTHETIC_CANARIES = Object.freeze([
  Object.freeze({
    kind: "credential",
    value: "TASK067_SyntheticCredential_Canary_7w9L3vX2",
  }),
  Object.freeze({
    kind: "token",
    value: "TASK067.SyntheticToken.Canary.4nQ8xL2pV7sK9mR5",
  }),
  Object.freeze({
    kind: "key",
    value: "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6s",
  }),
]);

const ACTIVE_INSTANCE_PATTERNS = Object.freeze([
  Object.freeze({ label: "aittadb.com hostname", pattern: /aittadb\.com/giu }),
  Object.freeze({ label: "chatgpt.site hostname", pattern: /chatgpt\.site/giu }),
  Object.freeze({ label: "iki.fi identity", pattern: /@iki\.fi/giu }),
  Object.freeze({
    label: "heusalagroup.fi identity",
    pattern: /@heusalagroup\.fi/giu,
  }),
]);

const TEXT_EXTENSIONS = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".map",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
]);
const LITERAL_ASSIGNMENT =
  /([A-Za-z_$][\w$-]{0,127})\s*(?::|=(?!=))\s*(["'`])((?:\\[\s\S]|(?!\2)[^\\\r\n])*)\2/gu;
const QUOTED_PROPERTY_ASSIGNMENT =
  /(["'])([A-Za-z_$][\w$-]{0,127})\1\s*:\s*(["'`])((?:\\[\s\S]|(?!\3)[^\\\r\n])*)\3/gu;
const ENVIRONMENT_DEFAULT =
  /(?:process\.env|import\.meta\.env|environment|env)(?:\.([A-Za-z_$][\w$]*)|\s*\[\s*(["'])([A-Za-z_$][\w$]*)\2\s*\])\s*(?:\?\?|\|\|)\s*(["'`])((?:\\[\s\S]|(?!\4)[^\\\r\n])*)\4/gu;

const findings = [];
const scannedFiles = [];

for (const root of PRODUCTION_ROOTS) {
  scanTree(root);
}
if (existsSync(join(PROJECT_ROOT, BUILD_ROOT))) {
  scanTree(BUILD_ROOT);
}

const envExamplePath = join(PROJECT_ROOT, ENV_EXAMPLE);
if (!existsSync(envExamplePath)) {
  addFinding(ENV_EXAMPLE, 0, "missing inert runtime example");
} else {
  const envText = readFileSync(envExamplePath, "utf8");
  scanExactBoundaries(ENV_EXAMPLE, envText);
  scanEnvironmentExample(envText);
}

if (findings.length > 0) {
  console.error(`Runtime secret boundary failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line}:${finding.column} ${finding.rule}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Runtime secret boundary is clean (${scannedFiles.length} production files and ${ENV_EXAMPLE})`,
  );
}

function scanTree(root) {
  const absoluteRoot = join(PROJECT_ROOT, root);
  if (!existsSync(absoluteRoot)) return;

  for (const absolutePath of filesBelow(absoluteRoot)) {
    const projectPath = portablePath(relative(PROJECT_ROOT, absolutePath));
    const bytes = readFileSync(absolutePath);
    const text = bytes.toString("utf8");
    scannedFiles.push(projectPath);
    scanExactBoundaries(projectPath, text);
    if (isTextFile(absolutePath, bytes)) {
      scanCommittedSecretAssignments(projectPath, text);
    }
  }
}

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesBelow(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function scanExactBoundaries(path, text) {
  for (const canary of SYNTHETIC_CANARIES) {
    let index = text.indexOf(canary.value);
    while (index !== -1) {
      addFinding(path, index, `contains synthetic ${canary.kind} canary`, text);
      index = text.indexOf(canary.value, index + canary.value.length);
    }
  }

  for (const activeInstance of ACTIVE_INSTANCE_PATTERNS) {
    activeInstance.pattern.lastIndex = 0;
    for (const match of text.matchAll(activeInstance.pattern)) {
      addFinding(
        path,
        match.index,
        `contains active ${activeInstance.label}`,
        text,
      );
    }
  }
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

function scanEnvironmentExample(text) {
  const lines = text.split(/\r?\n/u);
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
        addFinding(
          ENV_EXAMPLE,
          offset,
          `contains an active-looking value for ${name}`,
          text,
        );
      } else if (
        !isInertExampleValue(value) &&
        looksHighConfidenceSecret(value)
      ) {
        addFinding(
          ENV_EXAMPLE,
          offset,
          `contains an active-looking secret value in ${name}`,
          text,
        );
      }
    }
    offset += line.length + 1;
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
  return path.startsWith("dist/server/") &&
    path.endsWith("vinext-server.json") &&
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
  ) {
    return true;
  }
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
