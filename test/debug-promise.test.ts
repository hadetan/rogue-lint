import { analyzeProject } from "../src/api/analyze-project.js";
import { it } from "vitest";
import path from "node:path";

it("debug promise fixture", async () => {
  const result = await analyzeProject({
    cwd: process.cwd(),
    targetPath: path.join("test/fixtures", "returned-promise-issue-keys-basic"),
    format: "json",
  });
  const relevant = result.findings.filter(f =>
    f.entity.owner === "unrecognized" || f.entity.name === "keys" || f.entity.name === "[0]"
  );
  console.log("RELEVANT:", JSON.stringify(relevant, null, 2));
  console.log("SKIPPED COUNT:", result.skipped.length);
}, 60000);
