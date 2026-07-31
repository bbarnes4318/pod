import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, "src/lib/providers/tts/fishDialogue.ts");
let source = fs.readFileSync(target, "utf8");

function replaceOnce(from, to) {
  if (!source.includes(from)) {
    throw new Error(`Fish direction patch anchor not found: ${from.slice(0, 160)}`);
  }
  source = source.replace(from, to);
}

replaceOnce(
`const SLOW_QUIET_ANGER_CUES: Record<string, string | null> = {
  heated: "[slower, quieter, cold and precise]",
  excited: "[measured and intense, never rushed]",
  incredulous: "[quiet disbelief, unhurried]",
  dismissive: "[flat, slow, finished with this argument]",
};

const LOUD_SLOW_ANGER_CUES: Record<string, string | null> = {
  heated: "[loud and slow, stretching the important words]",
  excited: "[booming and unhurried, savoring it]",
  incredulous: "[loud disbelief, drawn out]",
  dismissive: "[loud, flat, dragging the words]",
};`,
`const SLOW_QUIET_ANGER_CUES: Record<string, string | null> = {
  heated: "[slow, quiet, cold, precise]",
  excited: "[measured, intense, controlled]",
  incredulous: "[quiet disbelief, unhurried]",
  dismissive: "[flat, slow, finished]",
};

const LOUD_SLOW_ANGER_CUES: Record<string, string | null> = {
  heated: "[loud, slow, stretching words]",
  excited: "[booming, slow, unhurried]",
  incredulous: "[loud disbelief, drawn out]",
  dismissive: "[loud, flat, dragging words]",
};`
);

replaceOnce(
`  const parts: string[] = [];
  let previousHostId: string | null = null;

  for (const utterance of input.utterances) {`,
`  const parts: string[] = [];
  let previousHostId: string | null = null;

  // One authored emotional peak per scene. Per-host budgets allowed every hot
  // speaker to receive a cue, which stamped synthetic emotion over the whole
  // exchange. Pick the strongest line; on a tie, the later line wins so the
  // performance can build rather than peak immediately.
  let accentLineIndex: number | null = null;
  let accentHeat = 2;
  for (const utterance of input.utterances) {
    const heat = lineHeat(utterance);
    if (heat >= 3 && heat >= accentHeat) {
      accentHeat = heat;
      accentLineIndex = utterance.lineIndex;
    }
  }

  for (const utterance of input.utterances) {`
);

replaceOnce(
`    if (used < cap && lineHeat(utterance) >= 3) {`,
`    if (used < cap && utterance.lineIndex === accentLineIndex) {`
);

fs.writeFileSync(target, source);
fs.rmSync(import.meta.filename);
console.log("patched Fish scene direction: one peak cue and distinct compact anger signatures");
