import { db } from "../lib/db";

async function main() {
  const approved = await db.topicCandidate.findFirst({
    where: { status: "approved" },
  });
  console.log("APPROVED_TOPIC:", approved);
}

main().catch(console.error);
