import { triggerResearchBriefGeneration } from "../app/admin/research-briefs/actions";

async function main() {
  console.log("Triggering Research Brief Generation for topic: a9982656-1217-40b2-891b-db81ac34ba09");
  const result = await triggerResearchBriefGeneration("a9982656-1217-40b2-891b-db81ac34ba09", true);
  console.log("TRIGGER_RESULT:", result);
}

main().catch(console.error);
