import { renderBenchmarkReport } from "./benchmark/reporting.js";
import { runWorkspaceBenchmark } from "./benchmark/run-benchmark.js";

async function main(): Promise<void> {
  const result = await runWorkspaceBenchmark(process.cwd());
  process.stdout.write(`${renderBenchmarkReport(result)}\n`);
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
