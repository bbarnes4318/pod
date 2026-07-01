import { sanitizeForGenericTts, sanitizeForBosonTts, chunkScriptText } from "../lib/providers/tts/sanitizer";

function runTests() {
  console.log("=== Running Boson TTS Sanitization & Chunking Tests ===");

  // Test 1: sanitizeForGenericTts
  console.log("\nTest 1: sanitizeForGenericTts");
  const text1 = "Hello! <|emotion:enthusiasm|> Welcome to the show. Check out https://google.com for info. *Bold text* and # Header";
  const expected1 = "Hello! Welcome to the show. Check out for info. Bold text and Header";
  const result1 = sanitizeForGenericTts(text1);
  if (result1 === expected1) {
    console.log("✅ PASS: Generic TTS sanitizer cleaned tags, URLs, and markdown correctly.");
  } else {
    console.log(`❌ FAIL: Expected "${expected1}", got "${result1}"`);
  }

  // Test 2: sanitizeForBosonTts
  console.log("\nTest 2: sanitizeForBosonTts");
  const text2 = "Hello! <|emotion:enthusiasm|> Valid tag. <|invalidcat:test|> Invalid tag. <|prosody:speed_slow|> Prosody tag. Check out https://url.com. *Italic text* and # Header";
  const expected2 = "Hello! <|emotion:enthusiasm|> Valid tag. Invalid tag. <|prosody:speed_slow|> Prosody tag. Check out Italic text and Header";
  const result2 = sanitizeForBosonTts(text2);
  if (result2 === expected2) {
    console.log("✅ PASS: Boson TTS sanitizer preserved valid tags and cleaned invalid tags, URLs, and markdown.");
  } else {
    console.log(`❌ FAIL: Expected "${expected2}", got "${result2}"`);
  }

  // Test 3: chunkScriptText avoids cutting inside a tag
  console.log("\nTest 3: chunkScriptText tag boundary protection");
  const text3 = "Hello! This is a long sentence that has some words and then a Boson tag <|emotion:contemplation|> at the end.";
  const chunks3 = chunkScriptText(text3, 80);
  console.log("Chunks generated:", chunks3);
  let hasBrokenTag = false;
  for (const chunk of chunks3) {
    if (chunk.includes("<|") && !chunk.includes("|>")) {
      hasBrokenTag = true;
    }
  }
  if (!hasBrokenTag && chunks3.length > 1) {
    console.log("✅ PASS: Chunks generated without breaking tags.");
  } else {
    console.log("❌ FAIL: Chunking broke tag boundaries or did not chunk.");
  }

  // Test 4: chunkScriptText sentence boundary protection
  console.log("\nTest 4: chunkScriptText sentence boundary protection");
  const text4 = "First sentence. Second sentence that is longer. Third sentence.";
  const chunks4 = chunkScriptText(text4, 40);
  console.log("Chunks generated:", chunks4);
  if (chunks4.length === 3 && chunks4[0] === "First sentence." && chunks4[1] === "Second sentence that is longer." && chunks4[2] === "Third sentence.") {
    console.log("✅ PASS: Chunks split on sentence boundaries.");
  } else {
    console.log("❌ FAIL: Chunks did not split on sentence boundaries correctly.");
  }

  console.log("\n=== Tests Completed ===");
}

runTests();
