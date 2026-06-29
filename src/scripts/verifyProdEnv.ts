import "dotenv/config";
import { validateProductionReadiness } from "../lib/services/productionEnvService";

console.log("=========================================");
console.log("TAKE MACHINE - PRODUCTION ENVIRONMENT AUDIT");
console.log("=========================================");

const result = validateProductionReadiness();

console.log(`Overall Readiness: ${result.passed ? "PASS 🚀" : "FAIL ❌"}`);
console.log("-----------------------------------------");

for (const check of result.checks) {
  const icon = check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "⚠";
  
  let displayStatus = "CONFIGURED";
  if (check.value === "MISSING") {
    displayStatus = "MISSING";
  } else if (check.value === "PLACEHOLDER" || check.value === "PLACEHOLDER (INVALID)") {
    displayStatus = "PLACEHOLDER";
  } else if (check.value === "[MASKED]" || check.value.includes("...")) {
    displayStatus = "[MASKED]";
  } else if (check.status === "warning" && check.value !== "MISSING") {
    displayStatus = "CONFIGURED";
  } else if (check.status === "fail") {
    displayStatus = "FAIL";
  }

  console.log(`[${icon}] ${check.key}: ${displayStatus}`);
  if (check.message) {
    console.log(`    Detail: ${check.message}`);
  }
}

console.log("=========================================");
if (!result.passed) {
  console.log("ERROR: One or more critical variables are missing or use placeholder/default values.");
  console.log("Please update your environment before running in production.");
  process.exit(1);
} else {
  console.log("Success: Environment is fully ready for production deployment!");
  process.exit(0);
}
