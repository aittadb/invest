import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname;
const SCANNER = join(PROJECT_ROOT, "scripts/check-runtime-secret-boundaries.mjs");
const CANARIES = Object.freeze([
  "TASK111_SyntheticCredential_Canary_7w9L3vX2",
  "TASK111.SyntheticBearerToken.Canary.4nQ8xL2pV7sK9mR5",
  "TASK111_SyntheticClientSecret_8pL4rN7vK2xQ5mC9",
  "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s",
  "r7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7vsr7w",
  "Task111-Private-Owner@Identity.Example.Test",
  "https://task111-private-runtime.example.test",
]);

test("scanner rejects sentinels in every release representation without echoing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "invest-secret-representations-"));
  const fixtures = [
    ["worker.js.map", JSON.stringify({ sourcesContent: [CANARIES[0]] })],
    ["manifest.json", JSON.stringify({ private_value: CANARIES[1] })],
    ["0001.sql", `-- ${CANARIES[2]}\nSELECT 1;`],
    ["response.html", `<p>${CANARIES[3]}</p>`],
    ["response.json", JSON.stringify({ error: CANARIES[4] })],
    ["review.csv", `field\n${CANARIES[5]}\n`],
    ["redirect.txt", `location: ${CANARIES[6]}\n`],
    ["csp.txt", `content-security-policy: default-src '${CANARIES[0]}'\n`],
    ["fixed-error.txt", `503 temporarily_unavailable ${CANARIES[1]}\n`],
  ];

  for (const [name, content] of fixtures) {
    const path = join(directory, name);
    writeFileSync(path, content, "utf8");
    const result = runScanner(["--scan-path", path]);
    assert.equal(result.status, 1, `${name} must fail the release scan`);
    assert.match(output(result), /Runtime secret boundary failed/u);
    assertNoCanary(output(result));
  }
});

test("scanner accepts clean release representations", () => {
  const directory = mkdtempSync(join(tmpdir(), "invest-secret-clean-"));
  for (const name of [
    "worker.js.map",
    "manifest.json",
    "0001.sql",
    "response.html",
    "response.json",
    "review.csv",
    "redirect.txt",
    "csp.txt",
    "fixed-error.txt",
  ]) {
    writeFileSync(join(directory, name), "synthetic clean release material\n", "utf8");
  }
  const result = runScanner(["--scan-path", directory]);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Runtime secret boundary is clean/u);
});

test("scanner distinguishes standalone credential formats from embedded task identifiers", () => {
  const directory = mkdtempSync(join(tmpdir(), "invest-secret-lexical-boundary-"));
  const embeddedTask = join(directory, "embedded-task.txt");
  const standaloneCredential = join(directory, "standalone-credential.txt");
  const underscorePrefixedCredential = join(directory, "underscore-prefixed-credential.txt");
  const hyphenPrefixedCredential = join(directory, "hyphen-prefixed-credential.txt");
  const prefix = ["s", "k", "-"].join("");
  const body = "A".repeat(16);

  writeFileSync(embeddedTask, `ta${prefix}${body}\n`, "utf8");
  writeFileSync(standaloneCredential, `${prefix}${body}\n`, "utf8");
  writeFileSync(underscorePrefixedCredential, `_${prefix}${body}\n`, "utf8");
  writeFileSync(hyphenPrefixedCredential, `-${prefix}${body}\n`, "utf8");

  const embeddedResult = runScanner(["--scan-path", embeddedTask]);
  assert.equal(embeddedResult.status, 0, output(embeddedResult));

  const standaloneResult = runScanner(["--scan-path", standaloneCredential]);
  assert.equal(standaloneResult.status, 1, output(standaloneResult));
  assert.match(output(standaloneResult), /known credential format/u);

  for (const fixture of [underscorePrefixedCredential, hyphenPrefixedCredential]) {
    const result = runScanner(["--scan-path", fixture]);
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /known credential format/u);
  }
});

test("scanner consumes external private values without retaining or echoing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "invest-secret-supplied-"));
  const sentinel = `task111-external-${process.pid}-${Date.now()}-private-value`;
  const sentinelFile = join(directory, "sentinels.json");
  const malformedFile = join(directory, "malformed-sentinels.json");
  const leakedFile = join(directory, "artifact.js");
  const cleanFile = join(directory, "clean.js");
  writeFileSync(
    sentinelFile,
    JSON.stringify([{ kind: "acceptance client value", value: sentinel }]),
    "utf8",
  );
  writeFileSync(leakedFile, `export const value = ${JSON.stringify(sentinel)};\n`, "utf8");
  writeFileSync(cleanFile, "export const value = 'clean';\n", "utf8");
  const environment = {
    ...process.env,
    INVEST_SECRET_SCAN_VALUES_FILE: sentinelFile,
  };

  chmodSync(sentinelFile, 0o644);
  const unsafe = runScanner(["--scan-path", leakedFile], environment);
  assert.equal(unsafe.status, 1);
  assert.equal(output(unsafe).includes(sentinel), false);
  chmodSync(sentinelFile, 0o600);
  const rejected = runScanner(["--scan-path", leakedFile], environment);
  assert.equal(rejected.status, 1);
  assert.equal(output(rejected).includes(sentinel), false);
  const accepted = runScanner(["--scan-path", cleanFile], environment);
  assert.equal(accepted.status, 0, output(accepted));

  writeFileSync(
    malformedFile,
    `[{"kind":"private value","value":"${sentinel}"`,
    "utf8",
  );
  chmodSync(malformedFile, 0o600);
  const malformed = runScanner(["--scan-path", cleanFile], {
    ...process.env,
    INVEST_SECRET_SCAN_VALUES_FILE: malformedFile,
  });
  assert.equal(malformed.status, 1);
  assert.equal(output(malformed).includes(sentinel), false);
  assert.match(output(malformed), /inspection failed closed/u);
});

test("scanner verifies complete Sites archive contents and rejects unsafe entry types", () => {
  const directory = mkdtempSync(join(tmpdir(), "invest-secret-archive-"));
  const cleanStage = join(directory, "clean");
  const leakedStage = join(directory, "leaked");
  const linkedStage = join(directory, "linked");
  const namedStage = join(directory, "named");
  const unnormalizedStage = join(directory, "unnormalized");
  const privateManifestStage = join(directory, "private-manifest");
  const duplicateManifestStage = join(directory, "duplicate-manifest");
  const cleanArchive = join(directory, "clean.tar.gz");
  const leakedArchive = join(directory, "leaked.tar.gz");
  const linkedArchive = join(directory, "linked.tar.gz");
  const namedArchive = join(directory, "named.tar.gz");
  const gzipNamedArchive = join(directory, "gzip-named.tar.gz");
  const unnormalizedArchive = join(directory, "unnormalized.tar.gz");
  const privateManifestArchive = join(directory, "private-manifest.tar.gz");
  const duplicateManifestArchive = join(directory, "duplicate-manifest.tar.gz");
  const probe = join(directory, "probe.txt");
  writeFileSync(probe, "clean probe\n", "utf8");

  stageArchive(cleanStage, "export default {};\n");
  stageArchive(leakedStage, `export default ${JSON.stringify(CANARIES[2])};\n`);
  stageArchive(linkedStage, "export default {};\n");
  stageArchive(namedStage, "export default {};\n");
  stageArchive(unnormalizedStage, "export default {};\n");
  stageArchive(privateManifestStage, "export default {};\n", {
    project_id: "appgprj_synthetic",
    d1: null,
    r2: null,
    internal_owner_alias: "private deployment value",
  });
  stageArchive(duplicateManifestStage, "export default {};\n");
  writeFileSync(
    join(duplicateManifestStage, "dist", ".openai", "hosting.json"),
    '{"project_id":"appgprj_Private123","project_id":"appgprj_synthetic","d1":null,"r2":null}',
    "utf8",
  );
  symlinkSync(
    "server/index.js",
    join(linkedStage, "dist", `${CANARIES[0]}.js`),
  );
  writeFileSync(
    join(namedStage, "dist", `${CANARIES[0]}.txt`),
    "clean body\n",
    "utf8",
  );
  createArchive(cleanStage, cleanArchive);
  createArchive(leakedStage, leakedArchive);
  createArchive(linkedStage, linkedArchive);
  createArchive(namedStage, namedArchive);
  createArchive(unnormalizedStage, unnormalizedArchive, false);
  createArchive(privateManifestStage, privateManifestArchive);
  createArchive(duplicateManifestStage, duplicateManifestArchive);
  writeFileSync(
    gzipNamedArchive,
    withGzipFilename(readFileSync(cleanArchive), CANARIES[1]),
  );

  const clean = runScanner(["--scan-path", probe, "--archive", cleanArchive]);
  assert.equal(clean.status, 0, output(clean));
  const leaked = runScanner(["--scan-path", probe, "--archive", leakedArchive]);
  assert.equal(leaked.status, 1);
  assertNoCanary(output(leaked));
  const linked = runScanner(["--scan-path", probe, "--archive", linkedArchive]);
  assert.equal(linked.status, 1);
  assert.match(output(linked), /unsafe type/u);
  assertNoCanary(output(linked));
  const named = runScanner(["--scan-path", probe, "--archive", namedArchive]);
  assert.equal(named.status, 1);
  assertNoCanary(output(named));
  const gzipNamed = runScanner([
    "--scan-path",
    probe,
    "--archive",
    gzipNamedArchive,
  ]);
  assert.equal(gzipNamed.status, 1);
  assertNoCanary(output(gzipNamed));
  const unnormalized = runScanner([
    "--scan-path",
    probe,
    "--archive",
    unnormalizedArchive,
  ]);
  assert.equal(unnormalized.status, 1);
  assert.match(output(unnormalized), /non-normalized owner metadata/u);
  const privateManifest = runScanner([
    "--scan-path",
    probe,
    "--archive",
    privateManifestArchive,
  ]);
  assert.equal(privateManifest.status, 1);
  assert.match(output(privateManifest), /invalid active hosting manifest/u);
  const duplicateManifest = runScanner([
    "--scan-path",
    probe,
    "--archive",
    duplicateManifestArchive,
  ]);
  assert.equal(duplicateManifest.status, 1);
  assert.match(output(duplicateManifest), /invalid active hosting manifest/u);
});

function stageArchive(stage, worker, hosting = {
  project_id: "appgprj_synthetic",
  d1: null,
  r2: null,
}) {
  mkdirSync(join(stage, "dist", "server"), { recursive: true });
  mkdirSync(join(stage, "dist", ".openai", "drizzle"), { recursive: true });
  writeFileSync(join(stage, "dist", "server", "index.js"), worker, "utf8");
  writeFileSync(
    join(stage, "dist", "server", "vinext-server.json"),
    JSON.stringify({ prerenderSecret: "a".repeat(64) }),
    "utf8",
  );
  writeFileSync(
    join(stage, "dist", ".openai", "hosting.json"),
    JSON.stringify(hosting),
    "utf8",
  );
  writeFileSync(
    join(stage, "dist", ".openai", "drizzle", "0001.sql"),
    "SELECT 1;\n",
    "utf8",
  );
}

function createArchive(stage, archive, normalizeOwnership = true) {
  const ownership = normalizeOwnership
    ? ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"]
    : [];
  execFileSync("tar", ["-czf", archive, ...ownership, "-C", stage, "dist"]);
}

function withGzipFilename(bytes, filename) {
  const header = Buffer.from(bytes.subarray(0, 10));
  header[3] |= 0x08;
  return Buffer.concat([
    header,
    Buffer.from(`${filename}\0`, "latin1"),
    bytes.subarray(10),
  ]);
}

function runScanner(argumentsList, environment = process.env) {
  return spawnSync(process.execPath, [SCANNER, ...argumentsList], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: environment,
  });
}

function output(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function assertNoCanary(value) {
  for (const canary of CANARIES) assert.equal(value.includes(canary), false);
}
