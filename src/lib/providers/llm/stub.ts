import { LLMProvider, GenerateTextOptions, GenerateStructuredOutputOptions } from "./interface";

export class StubLLMProvider implements LLMProvider {
  name = "stub-llm";

  async generateText(options: GenerateTextOptions): Promise<string> {
    console.log(`[StubLLMProvider] generateText called with prompt length: ${options.prompt.length}`);
    return `[STUB LLM RESPONSE] Debate Script:
Max Voltage: I can't believe we're actually debating this! Dr. Linebreak, look at the banners! Look at the rings! Legacy is on the line here!
Dr. Linebreak: Banners are lagging indicators, Max. If you look at their adjusted efficiency margin and true shooting percentage over the last fifteen games, they are a regression candidate.
Max Voltage: Efficiency? Let's talk about heart! Let's talk about performance under pressure!`;
  }

  async generateStructuredOutput<T = any>(options: GenerateStructuredOutputOptions): Promise<T> {
    console.log(`[StubLLMProvider] generateStructuredOutput called with prompt length: ${options.prompt.length}`);
    
    // Simulate a structured JSON response matching sports debate briefs
    const mockOutput = {
      topic: "Max vs Dr. Linebreak - Legacy vs Analytics",
      debateScore: 89,
      talkingPoints: [
        "Is rings/legacy more important than advanced efficiency stats?",
        "Do efficiency models underrepresent the psychological pressure of legacy games?"
      ],
      brief: "A simulated sports research brief for the hosts to reference."
    };

    return mockOutput as unknown as T;
  }
}
export default StubLLMProvider;
