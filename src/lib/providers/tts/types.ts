export interface SynthesizeSpeechInput {
  /** Spoken text. May contain whitelisted inline audio tags like [laughs]. */
  text: string;
  voiceId: string;
  speakerName?: string;
  /** Script tone label (heated, sarcastic, analytical, ...). */
  tone?: string;
  /** Vocal intensity for this line. */
  energy?: "low" | "medium" | "high";
  /** True when this line cuts the previous speaker off. */
  isInterruption?: boolean;
  /**
   * What this same speaker said before/after this line. Passed to engines
   * that support request conditioning (ElevenLabs previous_text/next_text)
   * so intonation doesn't reset at the start of every line.
   */
  previousText?: string;
  nextText?: string;
  /**
   * Short persona/delivery brief ("loud emotional sports host, mid-debate,
   * fired up") for instruction-steered engines (OpenAI gpt-4o-mini-tts).
   */
  voiceDirection?: string;
  format?: "mp3" | "wav";
}

export interface SynthesizeSpeechResult {
  audioBuffer: Buffer;
  contentType: string;
  durationMs?: number;
  providerAudioId?: string;
  raw?: unknown;
}

export interface TTSProvider {
  name: string;
  synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult>;
}
