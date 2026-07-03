export interface ValidationSummary {
  factualLineCount: number;
  factualLineWithEvidenceCount: number;
  evidenceCoveragePercent: number;
  unsupportedClaimCount: number;
  unsafeClaimCount: number;
  needsHumanReviewCount: number;
  invalidEvidenceRefCount: number;
  invalidFactualEvidenceRefCount: number;
  invalidNonFactualEvidenceRefCount: number;
  cleanedEvidenceRefCount: number;
  invalidSpeakerCount: number;
  totalLineCount: number;
  hostLineShare: Record<string, number>;
  lastValidatedAt: string;
  validationPassed: boolean;
  reasons: string[];
}

import { stripAudioTags } from "../audio/speechText";

// Rumor-sourcing language: banned on every line, factual or not.
const RUMOR_KEYWORDS = [
  "sources say",
  "rumored",
  "reportedly",
  "insider",
  "unnamed source",
];

// Hedging language: banned only on factual-claim lines (see scriptService).
const PROHIBITED_KEYWORDS = [
  ...RUMOR_KEYWORDS,
  "expected to",
  "likely to",
  "could be",
  "might be",
];

const VALID_EVIDENCE_TYPES = [
  "game",
  "newsItem",
  "injury",
  "oddsSnapshot",
  "teamStat",
  "playerStat",
];

export function validateScriptContent(
  content: any,
  episodeContext: {
    allowedSourceRefs: Set<string>;
    hostA: { id: string };
    hostB: { id: string };
    unsafeClaims: string[];
  }
): ValidationSummary {
  const summary: ValidationSummary = {
    factualLineCount: 0,
    factualLineWithEvidenceCount: 0,
    evidenceCoveragePercent: 0,
    unsupportedClaimCount: 0,
    unsafeClaimCount: 0,
    needsHumanReviewCount: 0,
    invalidEvidenceRefCount: 0,
    invalidFactualEvidenceRefCount: 0,
    invalidNonFactualEvidenceRefCount: 0,
    cleanedEvidenceRefCount: content?.safety?.cleanedEvidenceRefCount || 0,
    invalidSpeakerCount: 0,
    totalLineCount: 0,
    hostLineShare: { "Max Voltage": 0, "Dr. Linebreak": 0 },
    lastValidatedAt: new Date().toISOString(),
    validationPassed: false,
    reasons: [],
  };

  try {
    if (!content || typeof content !== "object") {
      summary.reasons.push("Script content is not a valid JSON object.");
      return summary;
    }

    if (!Array.isArray(content.segments) || content.segments.length === 0) {
      summary.reasons.push("Script segments is missing or is not a non-empty array.");
      return summary;
    }

    let maxVoltageCount = 0;
    let drLinebreakCount = 0;

    for (let sIdx = 0; sIdx < content.segments.length; sIdx++) {
      const seg = content.segments[sIdx];
      if (!seg || typeof seg !== "object") {
        summary.reasons.push(`Segment at index ${sIdx} is not a valid object.`);
        continue;
      }

      if (!Array.isArray(seg.lines) || seg.lines.length === 0) {
        summary.reasons.push(`Segment '${seg.title || sIdx}' is missing lines array or is empty.`);
        continue;
      }

      for (let lIdx = 0; lIdx < seg.lines.length; lIdx++) {
        const line = seg.lines[lIdx];
        if (!line || typeof line !== "object") {
          summary.reasons.push(`Line at segment ${sIdx}, line ${lIdx} is not a valid object.`);
          continue;
        }

        summary.totalLineCount++;

        // Confirm required fields
        if (
          line.lineIndex === undefined ||
          line.speakerName === undefined ||
          line.speakerHostId === undefined ||
          line.text === undefined ||
          line.tone === undefined ||
          line.isFactualClaim === undefined ||
          line.needsHumanReview === undefined ||
          !Array.isArray(line.evidenceRefs)
        ) {
          summary.reasons.push(`Line ${summary.totalLineCount} is missing required fields (lineIndex, speakerName, speakerHostId, text, tone, isFactualClaim, needsHumanReview, or evidenceRefs).`);
          continue;
        }

        // Validate speakerName
        if (line.speakerName !== "Max Voltage" && line.speakerName !== "Dr. Linebreak") {
          summary.invalidSpeakerCount++;
          summary.reasons.push(`Line ${summary.totalLineCount}: Invalid speakerName '${line.speakerName}'. Only 'Max Voltage' and 'Dr. Linebreak' allowed.`);
          continue;
        }

        // Validate speakerHostId
        if (line.speakerName === "Max Voltage" && line.speakerHostId !== episodeContext.hostA.id) {
          summary.invalidSpeakerCount++;
          summary.reasons.push(`Line ${summary.totalLineCount}: Max Voltage speakerHostId does not match the active Max Voltage profile ID.`);
        } else if (line.speakerName === "Dr. Linebreak" && line.speakerHostId !== episodeContext.hostB.id) {
          summary.invalidSpeakerCount++;
          summary.reasons.push(`Line ${summary.totalLineCount}: Dr. Linebreak speakerHostId does not match the active Dr. Linebreak profile ID.`);
        }

        // Track speaker count
        if (line.speakerName === "Max Voltage") {
          maxVoltageCount++;
        } else if (line.speakerName === "Dr. Linebreak") {
          drLinebreakCount++;
        }

        // Validate unsafe claims (on tag-free spoken content)
        const textLower = stripAudioTags(String(line.text)).toLowerCase();
        let usesUnsafeClaim = false;
        for (const claim of episodeContext.unsafeClaims) {
          if (textLower.includes(claim.toLowerCase())) {
            usesUnsafeClaim = true;
            break;
          }
        }

        if (usesUnsafeClaim) {
          summary.unsafeClaimCount++;
          summary.reasons.push(`Line ${summary.totalLineCount} states unsafe/unverified claim: "${line.text}".`);
        }

        // Track needsHumanReview count
        if (line.needsHumanReview === true) {
          summary.needsHumanReviewCount++;
          summary.reasons.push(`Line ${summary.totalLineCount} is marked as requiring human review.`);
        }

        // Validate evidenceRefs on every single line (factual and non-factual)
        let hasLineError = false;
        for (const ref of line.evidenceRefs) {
          let isRefValid = true;
          if (!ref || typeof ref !== "object" || !ref.type || !ref.id) {
            isRefValid = false;
          } else if (!VALID_EVIDENCE_TYPES.includes(ref.type)) {
            isRefValid = false;
          } else {
            const refKey = `${ref.type}:${ref.id}`;
            if (!episodeContext.allowedSourceRefs.has(refKey)) {
              isRefValid = false;
            }
          }

          if (!isRefValid) {
            summary.invalidEvidenceRefCount++;
            hasLineError = true;
            if (line.isFactualClaim) {
              summary.invalidFactualEvidenceRefCount++;
              summary.reasons.push(`Line ${summary.totalLineCount}: Invalid evidence reference on factual claim: ${JSON.stringify(ref)}.`);
            } else {
              summary.invalidNonFactualEvidenceRefCount++;
              summary.reasons.push(`Line ${summary.totalLineCount}: Invalid evidence reference on non-factual/opinion claim: ${JSON.stringify(ref)}.`);
            }
          }
        }

        // Validate factual lines rules
        if (line.isFactualClaim) {
          summary.factualLineCount++;

          if (line.evidenceRefs.length === 0) {
            summary.unsupportedClaimCount++;
            summary.reasons.push(`Line ${summary.totalLineCount}: Factual claim has no evidence references.`);
          } else if (!hasLineError) {
            summary.factualLineWithEvidenceCount++;
          }

          // Prohibited keywords in factual lines
          let containsProhibited = false;
          for (const word of PROHIBITED_KEYWORDS) {
            if (textLower.includes(word)) {
              containsProhibited = true;
              break;
            }
          }

          if (containsProhibited) {
            summary.unsupportedClaimCount++;
            summary.reasons.push(`Line ${summary.totalLineCount}: Factual claim contains prohibited rumor keyword.`);
          }
        } else {
          // Non-factual lines: only rumor-sourcing language is prohibited
          let containsProhibited = false;
          for (const word of RUMOR_KEYWORDS) {
            if (textLower.includes(word)) {
              containsProhibited = true;
              break;
            }
          }

          if (containsProhibited && line.evidenceRefs.length === 0) {
            summary.unsupportedClaimCount++;
            summary.reasons.push(`Line ${summary.totalLineCount}: Non-factual line contains prohibited keyword without evidenceRefs.`);
          }
        }
      }
    }

    // Calculations
    if (summary.factualLineCount > 0) {
      summary.evidenceCoveragePercent = Math.round(
        (summary.factualLineWithEvidenceCount / summary.factualLineCount) * 100
      );
    } else {
      summary.evidenceCoveragePercent = 100;
    }

    if (summary.totalLineCount > 0) {
      summary.hostLineShare["Max Voltage"] = Math.round((maxVoltageCount / summary.totalLineCount) * 100);
      summary.hostLineShare["Dr. Linebreak"] = Math.round((drLinebreakCount / summary.totalLineCount) * 100);
    }

    // Strict validation assertions
    if (summary.totalLineCount < 40) {
      summary.reasons.push(`Total lines count is ${summary.totalLineCount}, which is under the minimum of 40 lines.`);
    }

    if (summary.hostLineShare["Max Voltage"] < 25 || summary.hostLineShare["Dr. Linebreak"] < 25) {
      summary.reasons.push(`Dialogue split is unbalanced. Max Voltage has ${summary.hostLineShare["Max Voltage"]}%, Dr. Linebreak has ${summary.hostLineShare["Dr. Linebreak"]}%. Each must have at least 25%.`);
    }

    if (summary.evidenceCoveragePercent < 90) {
      summary.reasons.push(`Factual evidence coverage is ${summary.evidenceCoveragePercent}%, which is under the required 90%.`);
    }

  } catch (err: any) {
    summary.reasons.push(`System error during validation: ${err.message}`);
  }

  summary.validationPassed = summary.reasons.length === 0;
  return summary;
}

export function sanitizeScriptContent(
  content: any,
  episodeContext: {
    allowedSourceRefs: Set<string>;
    hostA: { id: string };
    hostB: { id: string };
  }
): { sanitizedContent: any; cleanedEvidenceRefCount: number } {
  let cleanedCount = 0;

  if (!content || typeof content !== "object") {
    return { sanitizedContent: content, cleanedEvidenceRefCount: 0 };
  }

  // Deep clone input content
  const sanitized = JSON.parse(JSON.stringify(content));

  if (!Array.isArray(sanitized.segments)) {
    return { sanitizedContent: sanitized, cleanedEvidenceRefCount: 0 };
  }

  let globalIndex = 0;

  for (const seg of sanitized.segments) {
    if (!seg || typeof seg !== "object" || !Array.isArray(seg.lines)) {
      continue;
    }

    for (const line of seg.lines) {
      if (!line || typeof line !== "object") continue;

      // Normalize lineIndex values globally within segments
      line.lineIndex = globalIndex++;

      // Ensure speakerHostId matches the active speaker ID
      if (line.speakerName === "Max Voltage") {
        line.speakerHostId = episodeContext.hostA.id;
      } else if (line.speakerName === "Dr. Linebreak") {
        line.speakerHostId = episodeContext.hostB.id;
      }

      // Sanitize evidenceRefs on every single line (factual & non-factual)
      if (Array.isArray(line.evidenceRefs)) {
        const originalLength = line.evidenceRefs.length;
        line.evidenceRefs = line.evidenceRefs.filter((ref: any) => {
          if (!ref || typeof ref !== "object" || !ref.type || !ref.id) {
            return false;
          }
          if (!VALID_EVIDENCE_TYPES.includes(ref.type)) {
            return false;
          }
          const refKey = `${ref.type}:${ref.id}`;
          return episodeContext.allowedSourceRefs.has(refKey);
        });

        cleanedCount += (originalLength - line.evidenceRefs.length);
      } else {
        line.evidenceRefs = [];
      }
    }
  }

  return {
    sanitizedContent: sanitized,
    cleanedEvidenceRefCount: cleanedCount,
  };
}
