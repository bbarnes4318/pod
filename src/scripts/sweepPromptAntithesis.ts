// Sweeps the prompt-bearing files for the balanced-negation frame.
//
// The model imitates the register of its instructions, so a prompt written in
// balanced negation produces dialogue written in balanced negation. Run this
// after editing any prompt text, including host speakingStyle and
// argumentPatterns in prisma/seed.ts, which are injected verbatim.
//
// Expected residue: the quoted BANNED SHAPES examples in the debate contract
// (they have to name the frame to ban it), and "MORE precise than the evidence"
// in the rewrite prompt, which is a plain comparative the less_X_more_Y rule
// over-matches.

import fs from "node:fs";
import { findAntithesis } from "../lib/services/scriptAntithesis";

const FILES = [
  "prisma/seed.ts",
  "src/lib/formats/formatScriptPrompts.ts",
  "src/lib/queue/worker.ts",
  "src/lib/services/scriptOutlineEngine.ts",
  "src/lib/services/researchBriefService.ts",
  "src/lib/services/semanticReview.ts",
];

for (const f of FILES) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  let n = 0;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    // Skip code comments — this sweep only touches text sent to a model.
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    const hits = findAntithesis(raw);
    if (!hits.length) return;
    n += hits.length;
    for (const h of hits) console.log(`${f}:${i + 1}  [${h.kind}]  ${h.span}`);
  });
  console.log(`== ${f}: ${n} frame(s) in model-facing text\n`);
}
