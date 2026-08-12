import { getLLMProvider } from "./src/lib/providers/llm/factory";
async function main() {
  const prov = getLLMProvider({ provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b" });
  try {
    const r: any = await prov.generateStructuredOutput({
      prompt: 'Return JSON only: {"ok":true}', maxTokens: 300, temperature: 0,
    });
    console.log("NEMOTRON_STRUCTURED_OK " + JSON.stringify(r).slice(0, 60));
  } catch (e: any) {
    console.log("NEMOTRON_STILL_FAILING " + String(e?.message || e).replace(/\s+/g, " ").slice(0, 200));
  }
}
main();
