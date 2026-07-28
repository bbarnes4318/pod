import { stripAudioTags } from "../audio/speechText";
import { findRepetitions } from "./scriptRepetition";

export interface MovementQualityInput {
  segments: any[];
  softWordTarget: number;
  priorClaims?: string[];
}

export interface MovementQualityReport {
  passed: boolean;
  lines: number;
  words: number;
  minimumWords: number;
  repeatedCurrentLines: number;
  repetitionRatio: number;
  strictAlternationRatio: number;
  sameSpeakerBuilds: number;
  shortReactionRatio: number;
  failures: string[];
}

function spokenWords(text: unknown): string[] {
  return stripAudioTags(String(text || "")).trim().split(/\s+/).filter(Boolean);
}

export function evaluateMovementQuality(input: MovementQualityInput): MovementQualityReport {
  const lines = (input.segments || []).flatMap((segment) =>
    Array.isArray(segment?.lines) ? segment.lines : []
  );
  const texts = lines.map((line: any) => String(line?.text || ""));
  const words = texts.reduce((total, text) => total + spokenWords(text).length, 0);
  const minimumWords = Math.max(160, Math.round(input.softWordTarget * 0.82));

  const priorClaims = (input.priorClaims || []).filter(Boolean);
  const repetition = findRepetitions([...priorClaims, ...texts]);
  const repeatedCurrentLines = repetition.repeats.filter((hit) => hit.index >= priorClaims.length).length;
  const repetitionRatio = repeatedCurrentLines / Math.max(1, texts.length);

  let alternations = 0;
  let sameSpeakerBuilds = 0;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index - 1]?.speakerName === lines[index]?.speakerName) sameSpeakerBuilds++;
    else alternations++;
  }
  const strictAlternationRatio = alternations / Math.max(1, lines.length - 1);
  const shortReactionRatio = lines.filter((line: any) => spokenWords(line?.text).length <= 6).length / Math.max(1, lines.length);

  const failures: string[] = [];
  if (words < minimumWords) {
    failures.push(`movement has ${words} spoken words; it requires at least ${minimumWords}`);
  }
  if (repeatedCurrentLines >= Math.max(3, Math.ceil(texts.length * 0.20)) || repetitionRatio > 0.22) {
    failures.push(`${repeatedCurrentLines}/${texts.length} movement lines repeat an earlier point`);
  }
  if (
    lines.length >= 8 &&
    strictAlternationRatio > 0.96 &&
    sameSpeakerBuilds === 0 &&
    shortReactionRatio < 0.12
  ) {
    failures.push(
      `mechanical turn shape: ${Math.round(strictAlternationRatio * 100)}% strict alternation with no same-speaker build and almost no short reactions`
    );
  }

  return {
    passed: failures.length === 0,
    lines: lines.length,
    words,
    minimumWords,
    repeatedCurrentLines,
    repetitionRatio,
    strictAlternationRatio,
    sameSpeakerBuilds,
    shortReactionRatio,
    failures,
  };
}
