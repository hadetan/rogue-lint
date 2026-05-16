import { repoDirectModuleWiringConfig } from "./direct-module-wiring/config.js";
import {
  formatDirectModuleWiringViolations,
  validateDirectModuleWiring,
} from "./direct-module-wiring/validator.js";

const result = validateDirectModuleWiring(process.cwd(), repoDirectModuleWiringConfig);

if (result.violations.length > 0) {
  console.error(formatDirectModuleWiringViolations(result.violations));
  process.exitCode = 1;
} else {
  console.log(`direct module wiring: checked ${result.scannedFiles} managed source files, no configured violations found`);
}