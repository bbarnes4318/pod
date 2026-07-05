/**
 * Live TTS samples: one Boson line + one Fish Audio line, each through its
 * own formatting layer, saved to samples/.
 *
 *   npm run sample:tts
 *
 * Requires BOSON_API_KEY and FISH_API_KEY in .env. Prints the exact tagged
 * payload each provider received so tag placement can be inspected.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { BosonTTSProvider } from "../lib/providers/tts/boson";
import { FishTTSProvider } from "../lib/providers/tts/fish";
import { formatLineForBoson } from "../lib/providers/tts/bosonFormat";
import { formatLineForFish } from "../lib/providers/tts/fishFormat";

const LINE = {
  text: "Ninety-one points?! [laughs] Come on. [pause] You watched that fourth quarter and you're telling me the defense is the problem?",
  tone: "incredulous",
  energy: "high" as const,
  isInterruption: false,
};

async function main() {
  const outDir = path.join(process.cwd(), "samples");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("=== Formatted payloads ===\n");
  console.log("BOSON:", formatLineForBoson(LINE));
  console.log("\nFISH: ", formatLineForFish(LINE));
  console.log(`\nFish model: ${process.env.FISH_MODEL || "s2.1-pro-free"}`);

  const results: Record<string, string> = {};

  for (const [name, provider] of [
    ["boson", new BosonTTSProvider()],
    ["fish", new FishTTSProvider()],
  ] as const) {
    try {
      const t0 = Date.now();
      const res = await provider.synthesizeSpeech({
        text: LINE.text,
        voiceId: "",
        speakerName: "Max Voltage",
        tone: LINE.tone,
        energy: LINE.energy,
        isInterruption: LINE.isInterruption,
        format: "mp3",
      });
      const file = path.join(outDir, `tts-sample-${name}.mp3`);
      fs.writeFileSync(file, res.audioBuffer);
      results[name] = `OK ${(res.audioBuffer.length / 1024).toFixed(1)} KB in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${file}`;
    } catch (err) {
      results[name] = `FAILED: ${(err as Error).message.slice(0, 300)}`;
    }
  }

  console.log("\n=== Synthesis results ===");
  for (const [name, r] of Object.entries(results)) console.log(`${name}: ${r}`);
  const failed = Object.values(results).some((r) => r.startsWith("FAILED"));
  process.exit(failed ? 1 : 0);
}

void main();
