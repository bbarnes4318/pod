// WHO IS WRITING THIS SHOW — the routing table, printed.
//
//   npm run audit:llm-routing
//   npm run audit:llm-routing -- --all      every declared role, not just the nine
//   npm run audit:llm-routing -- --json     machine-readable
//
// Reads configuration only. It resolves no provider, makes no request and spends
// nothing, so it is safe to run against production configuration at any time.
//
// It prints PROVIDER AND MODEL NAMES ONLY. Credentials are reported as a
// presence bit and never as a value, a prefix or a length.
//
// EXIT CODE. Zero unless something is structurally wrong: a role that resolves
// to nothing, a judge grading its own output, or a judge on the writers' provider
// while another credentialed provider sat unused. A single-provider deployment
// exits zero with warnings — it is a limitation of the account, not a mistake in
// the configuration, and blocking on it would just mean nobody runs this.

import "dotenv/config";

import {
  ALL_ROLES,
  type LLMRole,
} from "../lib/providers/llm/roles";
import {
  PRODUCTION_WRITING_ROLES,
  auditRoleRouting,
  planColdOpenWriterRoutes,
  renderRoutingTable,
} from "../lib/providers/llm/routingAudit";
import { activeRoutingProfile, routingProfileIsUnrecognized } from "../lib/providers/llm/profiles";

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const roles: readonly LLMRole[] = argv.includes("--all") ? ALL_ROLES : PRODUCTION_WRITING_ROLES;

  const report = auditRoleRouting(roles);
  const profile = activeRoutingProfile();
  const unrecognized = routingProfileIsUnrecognized();
  const coldOpenPlan = planColdOpenWriterRoutes();

  if (asJson) {
    console.log(
      JSON.stringify({ profile, unrecognizedProfile: unrecognized, coldOpenPlan, ...report }, null, 2)
    );
  } else {
    console.log(`\nLLM ROLE ROUTING — profile: ${profile}${profile === "legacy" ? " (the default; every role falls back to the grouped LLM_* / SCRIPT_LLM_* / VERIFY_* variables)" : ""}`);
    if (unrecognized.unrecognized) {
      console.log(`  WARNING: LLM_ROUTING_PROFILE=${unrecognized.raw} is not a known profile; 'legacy' is in effect.`);
    }
    console.log("");
    console.log(renderRoutingTable(report.rows));

    console.log(`\nProvider concentration`);
    for (const c of report.concentration) {
      console.log(`  ${c.provider.padEnd(12)} ${c.roles.length} role(s): ${c.roles.join(", ")}`);
    }
    console.log(`  credentialed providers: ${report.configuredProviders.join(", ") || "(none)"}`);

    if (report.collapses.length) {
      console.log(`\nRoles sharing ONE endpoint`);
      for (const c of report.collapses) {
        console.log(`  ${c.label} <- ${c.roles.join(", ")}`);
      }
    }

    console.log(`\nHost writers`);
    console.log(`  A: ${report.hostWriters.hostA}`);
    console.log(`  B: ${report.hostWriters.hostB}`);
    console.log(`  separate: ${report.hostWriters.separate}${report.hostWriters.reason ? ` — ${report.hostWriters.reason}` : ""}`);
    if (report.hostWriters.remedy) console.log(`  remedy: ${report.hostWriters.remedy}`);

    console.log(`\nJudges`);
    for (const j of report.judges) {
      console.log(`  ${j.judgeRole.padEnd(18)} ${j.judgeLabel.padEnd(32)} independence=${j.independent} level=${j.level} acceptable=${j.acceptable}`);
      if (j.reason) console.log(`    ${j.reason}`);
      if (j.remedy) console.log(`    remedy: ${j.remedy}`);
    }

    console.log(`\nCold-open candidate writers`);
    if (!coldOpenPlan.length) {
      console.log(
        `  single-writer path — fewer than two DISTINCT credentialed writer routes, so all three candidates ` +
          `come from one model. Route SCRIPT_HOST_B_WRITER_LLM_PROVIDER or SCRIPT_STORY_EDITOR_LLM_PROVIDER ` +
          `elsewhere to contest the tournament.`
      );
    } else {
      for (const c of coldOpenPlan) console.log(`  ${c.variantId.padEnd(15)} ${c.label} (${c.llmRole})`);
    }

    if (report.uncredentialed.length) {
      console.log(`\nRoles with NO usable credential (these fail at call time): ${report.uncredentialed.join(", ")}`);
    }
  }

  // An all-stub environment is a TEST HARNESS, not a deployment. There is no
  // routing decision in it to be right or wrong about, so auditing it would only
  // ever report the absence of configuration as a configuration fault — and
  // failing CI on that would teach everyone to ignore this command.
  const allStub = report.rows.length > 0 && report.rows.every((r) => r.provider === "stub");
  if (allStub) {
    if (!asJson) {
      console.log(
        "\nEvery role resolves to the stub provider: this is a test environment, not a routing " +
          "configuration. Nothing to audit.\n"
      );
    }
    process.exit(0);
  }

  // Only genuinely broken configurations fail the command.
  const unresolved = report.rows.filter((r) => r.source === "unresolved").map((r) => r.role);
  const capturedJudges = report.judges.filter((j) => !j.acceptable);
  if (unresolved.length || capturedJudges.length) {
    if (!asJson) {
      console.error(
        `\nFAIL: ${[
          unresolved.length ? `${unresolved.length} role(s) resolve to nothing: ${unresolved.join(", ")}` : "",
          capturedJudges.length
            ? `${capturedJudges.length} judge(s) are not independently routed: ${capturedJudges.map((j) => j.judgeRole).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("; ")}\n`
      );
    }
    process.exit(1);
  }
  if (!asJson) console.log("\nNo structural routing faults.\n");
}

main();
