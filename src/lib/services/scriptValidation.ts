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

import { EVIDENCE_TYPES } from "./evidenceRefs";
import { stripAudioTags } from "../audio/speechText";
import { findRumorKeyword, isGenuineFactualAssertion } from "./claimLanguage";

// The SHARED list — this was three identical copies, which is precisely how
// `topicSource` would have been added to the pipeline and silently stripped
// here. One definition, in src/lib/services/evidenceRefs.ts.
const VALID_EVIDENCE_TYPES: readonly string[] = EVIDENCE_TYPES;

export function validateScriptContent(
  content: any,
  episodeContext: {
    allowedSourceRefs: Set<string>;
    /** Legacy two-host context (still accepted). */
    hostA?: { id: string; name: string };
    hostB?: { id: string; name: string };
    /** Prompt 7: the FULL episode cast in seat order (1-4). Supersedes
     *  hostA/hostB when present. */
    cast?: Array<{ id: string; name: string }>;
    /** The episode's show format — supplies per-chair approval floors.
     *  Absent = the two-host debate policy (25% each), the legacy behavior. */
    format?: import("../formats/showFormatRegistry").ShowFormat | null;
    unsafeClaims: string[];
  }
): ValidationSummary {
  // Whichever hosts this episode was cast with — no hardcoded names.
  const castList: Array<{ id: string; name: string }> =
    episodeContext.cast && episodeContext.cast.length > 0
      ? episodeContext.cast
      : [episodeContext.hostA!, episodeContext.hostB!].filter(Boolean);
  const castByName = new Map<string, { id: string; name: string }>(
    castList.map((h) => [h.name.toLowerCase(), h])
  );
  const hostForSpeaker = (speakerName: unknown) =>
    typeof speakerName === "string" ? castByName.get(speakerName.trim().toLowerCase()) : undefined;

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
    hostLineShare: Object.fromEntries(castList.map((h) => [h.name, 0])),
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

    const lineCountByHostId = new Map<string, number>(castList.map((h) => [h.id, 0]));

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

        // Validate speakerName against the episode's cast (either host).
        const speakerHost = hostForSpeaker(line.speakerName);
        if (!speakerHost) {
          summary.invalidSpeakerCount++;
          summary.reasons.push(
            `Line ${summary.totalLineCount}: Invalid speakerName '${line.speakerName}'. Allowed: ${castList.map((h) => `'${h.name}'`).join(", ")}.`
          );
          continue;
        }

        // Validate speakerHostId matches the host that speakerName resolves to.
        if (line.speakerHostId !== speakerHost.id) {
          summary.invalidSpeakerCount++;
          summary.reasons.push(
            `Line ${summary.totalLineCount}: ${speakerHost.name} speakerHostId does not match the cast host profile ID.`
          );
        }

        // Track speaker count by host id.
        lineCountByHostId.set(speakerHost.id, (lineCountByHostId.get(speakerHost.id) ?? 0) + 1);

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

        // Fact vs opinion: a ref-less line in clear opinion/prediction
        // framing is held to the opinion rules even if the writer marked it
        // isFactualClaim — hot takes are the show format, not citations.
        // Speculation phrasing ("likely to", "could be") is never flagged
        // here; only fabricated-sourcing language is prohibited, and the
        // fact checker separately verifies evidence-backed phrasing.
        if (isGenuineFactualAssertion(line, textLower)) {
          summary.factualLineCount++;

          if (line.evidenceRefs.length === 0) {
            summary.unsupportedClaimCount++;
            summary.reasons.push(`Line ${summary.totalLineCount}: Factual claim has no evidence references.`);
          } else if (!hasLineError) {
            summary.factualLineWithEvidenceCount++;
          }

          if (findRumorKeyword(textLower)) {
            summary.unsupportedClaimCount++;
            summary.reasons.push(`Line ${summary.totalLineCount}: Factual claim contains prohibited rumor-sourcing keyword.`);
          }
        } else {
          // Opinion/non-factual lines: only rumor-sourcing language is
          // prohibited (without evidence to point at, "sources say" is
          // fabricated attribution even inside an opinion).
          if (findRumorKeyword(textLower) && line.evidenceRefs.length === 0) {
            summary.unsupportedClaimCount++;
            summary.reasons.push(`Line ${summary.totalLineCount}: Line uses rumor-sourcing language without evidenceRefs.`);
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
      for (const h of castList) {
        summary.hostLineShare[h.name] = Math.round(((lineCountByHostId.get(h.id) ?? 0) / summary.totalLineCount) * 100);
      }
    }

    // Strict validation assertions
    if (summary.totalLineCount < 40) {
      summary.reasons.push(`Total lines count is ${summary.totalLineCount}, which is under the minimum of 40 lines.`);
    }

    // Per-chair approval floors from the show format (Prompt 7). Without a
    // format the legacy two-host debate policy applies: 25% per chair.
    {
      const floors = castList.map((h, seat) => ({
        name: h.name,
        pct: summary.hostLineShare[h.name] ?? 0,
        floor: episodeContext.format
          ? episodeContext.format.roles[Math.min(seat, episodeContext.format.roles.length - 1)].minLineSharePct
          : 25,
      }));
      const under = floors.filter((f) => f.pct < f.floor);
      if (under.length > 0) {
        summary.reasons.push(
          `Dialogue split is unbalanced. ${floors.map((f) => `${f.name} has ${f.pct}%`).join(", ")}. ` +
            under.map((f) => `${f.name} must have at least ${f.floor}%`).join("; ") + "."
        );
      }
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
    hostA?: { id: string; name: string };
    hostB?: { id: string; name: string };
    /** Prompt 7: the FULL cast (supersedes hostA/hostB when present). */
    cast?: Array<{ id: string; name: string }>;
  }
): { sanitizedContent: any; cleanedEvidenceRefCount: number } {
  const castList: Array<{ id: string; name: string }> =
    episodeContext.cast && episodeContext.cast.length > 0
      ? episodeContext.cast
      : [episodeContext.hostA!, episodeContext.hostB!].filter(Boolean);
  const hostIdByName = new Map<string, string>(castList.map((h) => [h.name.toLowerCase(), h.id]));
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

      // Ensure speakerHostId matches the cast host this line's speaker names.
      if (typeof line.speakerName === "string") {
        const boundId = hostIdByName.get(line.speakerName.trim().toLowerCase());
        if (boundId) line.speakerHostId = boundId;
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
