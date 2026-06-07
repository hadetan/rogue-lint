import { repoLiteralOwnershipConfig } from "./literal-ownership/config.js";
import { formatLiteralOwnershipViolations, validateLiteralOwnership } from "./literal-ownership/validator.js";

const result = validateLiteralOwnership(process.cwd(), repoLiteralOwnershipConfig);

if (result.violations.length > 0) {
  console.error(formatLiteralOwnershipViolations(result.violations));
  process.exitCode = 1;
} else {
  console.log(`literal ownership: checked ${result.scannedFiles} managed source files, no configured violations found`);
}