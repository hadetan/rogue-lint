import { analyzeProject } from "../src/api/analyze-project.js";
import { it } from "vitest";
import path from "node:path";

const FIXTURES_DIR = path.resolve("test/fixtures");

it("debug binary-assigned", async () => {
  const result = await analyzeProject({
    cwd: process.cwd(),
    targetPath: path.join(FIXTURES_DIR, "returned-run-payload-binary-assignment-issue-keys-basic"),
    format: "json",
  });
  const relevant = result.findings.filter(f =>
    f.entity.owner === "unrecognized" || f.entity.name === "keys" || f.entity.name === "[0]"
  );
  console.log("RELEVANT FINDINGS:", JSON.stringify(relevant, null, 2));
  console.log("SKIPPED:", JSON.stringify(result.skipped.slice(0, 5), null, 2));
}, 60000);
