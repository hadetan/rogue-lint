import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    // Self-host analysis takes ~60s. Running forks concurrently causes CPU
    // contention that pushes it past the 60s vitest-worker IPC timeout,
    // corrupting test result reporting. Sequential execution keeps each
    // fork under the threshold.
    maxWorkers: 1,
  },
});
