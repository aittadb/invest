import {
  HostedStorageProofConfigurationFailure,
  configurationFailureReport,
  formatHostedStorageProofReport,
  loadHostedStorageProofConfiguration,
  runHostedStorageAdapterProof,
} from "./hosted-storage-proof-runner.ts";

const path = process.env.INVEST_HOSTED_STORAGE_PROOF_CONFIG_FILE;

try {
  if (path === undefined || path === "") {
    throw new HostedStorageProofConfigurationFailure();
  }
  const configuration = loadHostedStorageProofConfiguration(path);
  const report = await runHostedStorageAdapterProof(configuration);
  process.stdout.write(formatHostedStorageProofReport(report));
  if (report.status !== "passed") process.exitCode = 1;
} catch {
  process.stdout.write(formatHostedStorageProofReport(configurationFailureReport()));
  process.exitCode = 1;
}
