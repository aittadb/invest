import {
  HostedStorageProofConfigurationFailure,
  configurationFailureReport,
  formatHostedStorageCleanupDiagnostic,
  formatHostedStorageProofReport,
  loadHostedStorageProofConfiguration,
  runHostedStorageAdapterProof,
  runHostedStorageAdapterProofWithCleanupDiagnostic,
} from "./hosted-storage-proof-runner.ts";

const args = process.argv.slice(2);
const cleanupDiagnostic = args.length === 1 && args[0] === "--cleanup-diagnostic";

if (args.length !== 0 && !cleanupDiagnostic) {
  process.stderr.write("Invalid hosted storage proof arguments.\n");
  process.exitCode = 1;
} else {
const path = process.env.INVEST_HOSTED_STORAGE_PROOF_CONFIG_FILE;

try {
  if (path === undefined || path === "") {
    throw new HostedStorageProofConfigurationFailure();
  }
  const configuration = loadHostedStorageProofConfiguration(path);
  if (cleanupDiagnostic) {
    const run = await runHostedStorageAdapterProofWithCleanupDiagnostic(
      configuration,
    );
    if (run.diagnostic !== undefined) {
      process.stdout.write(formatHostedStorageCleanupDiagnostic(run.diagnostic));
    }
    if (run.report.status !== "passed") process.exitCode = 1;
  } else {
    const report = await runHostedStorageAdapterProof(configuration);
    process.stdout.write(formatHostedStorageProofReport(report));
    if (report.status !== "passed") process.exitCode = 1;
  }
} catch {
  if (!cleanupDiagnostic) {
    process.stdout.write(formatHostedStorageProofReport(configurationFailureReport()));
  }
  process.exitCode = 1;
}
}
