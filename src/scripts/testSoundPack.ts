// Synthesizes the full starter sound pack locally and verifies every asset
// decodes with the expected duration. Run: npm run test:sound-pack
// Pass --keep to print the output directory for listening.

import fs from "fs";
import { generateStarterPack } from "../lib/audio/soundPackGenerator";
import { getFileDurationMs } from "../lib/audio/assembly";

async function main() {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  const keep = process.argv.includes("--keep");

  console.log("Synthesizing starter sports pack…");
  const { dir, assets } = await generateStarterPack(ffmpegPath);

  let failed = 0;
  for (const asset of assets) {
    const size = fs.statSync(asset.filePath).size;
    const durMs = await getFileDurationMs(ffprobePath, asset.filePath);
    const expected = asset.durationSec * 1000;
    const durOk = Math.abs(durMs - expected) < 400; // mp3 padding tolerance
    const ok = size > 4000 && durOk;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${asset.kind.padEnd(11)} ${asset.name.padEnd(32)} ${(size / 1024).toFixed(0).padStart(4)}KB ${(durMs / 1000).toFixed(2)}s`
    );
  }

  if (keep) {
    console.log(`\nAssets kept at: ${dir}`);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${assets.length - failed}/${assets.length} assets OK`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
