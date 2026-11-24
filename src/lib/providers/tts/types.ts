export interface SynthesizeSpeechInput {
  /** Spoken text. May contain whitelisted inline audio tags like [laughs]. */
  text: string;
  voiceId: string;
  speakerName?: string;
  /** 0-based chair for this line's speaker, from the resolved cast. Providers
   *  use it to pick <PROVIDER>_HOST_A..D_VOICE_ID when voiceId is unusable.
   *  Keying the fallback on the seat rather than the speaker's name is what
   *  keeps a roster change from dropping a host onto the shared voice. */
  seatIndex?: number;
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
   * fired up") for instruction-steered engines and Fish's cue formatter.
   */
  voiceDirection?: string;
  /** Optional provider-neutral preview controls. Providers that do not expose
   * these knobs may ignore them; Fish maps them directly to its documented
   * prosody and sampling fields. */
  speed?: number;
  volume?: number;
  temperature?: number;
  topP?: number;
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
