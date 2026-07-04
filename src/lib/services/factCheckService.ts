import { db } from "@/lib/db";
import { getLLMProvider } from "@/lib/providers/llm/factory";
import { stripAudioTags } from "@/lib/audio/speechText";

const PROHIBITED_KEYWORDS = [
  "sources say",
  "rumored",
  "reportedly",
  "expected to",
  "likely to",
  "insider",
  "unnamed source",
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

interface FactCheckInput {
  scriptId: string;
  forceRecheck?: boolean;
}

function isRumorPhraseSupported(lineText: string, rumorWord: string, allowedTexts: string[]): boolean {
  const cleanLine = lineText.toLowerCase().replace(rumorWord, " ").replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, " ");
  const lineWords = cleanLine
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !["this", "that", "with", "from", "they", "were", "have", "been", "will", "would", "about", "their"].includes(w));

  if (lineWords.length === 0) return false;

  for (const allowedText of allowedTexts) {
    const hasRumorContext =
      allowedText.includes(rumorWord) ||
      allowedText.includes("rumor") ||
      allowedText.includes("report") ||
      allowedText.includes("expect") ||
      allowedText.includes("likely") ||
      allowedText.includes("could") ||
      allowedText.includes("might");

    if (!hasRumorContext) continue;

    let matchCount = 0;
    for (const word of lineWords) {
      if (allowedText.includes(word)) {
        matchCount++;
      }
    }

    const ratio = matchCount / lineWords.length;
    if (ratio >= 0.6) {
      return true;
    }
  }

  return false;
}

export async function factCheckScript({ scriptId, forceRecheck = false }: FactCheckInput) {
  // 1. Eligibility Checks
  const script = await db.script.findUnique({
    where: { id: scriptId },
    include: {
      episode: {
        include: {
          topics: {
            orderBy: { orderIndex: "asc" },
            include: {
              topic: {
                include: {
                  researchBrief: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!script) {
    throw new Error(`Script with ID ${scriptId} not found.`);
  }

  if (script.status !== "approved" && script.status !== "draft" && script.status !== "needs_revision") {
    throw new Error(`Script status is '${script.status}'. Only draft, needs_revision, or approved scripts can be fact checked.`);
  }

  if (!script.content || typeof script.content !== "object") {
    throw new Error("Script content is missing or is not a structured JSON object.");
  }

  if (!script.plainText || !script.plainText.trim()) {
    throw new Error("Script plainText transcript is empty.");
  }

  if (script.episode.topics.length === 0) {
    throw new Error("Episode has no linked topics.");
  }

  // Verify all linked topics have research briefs with facts and sourceIds
  for (const et of script.episode.topics) {
    if (!et.topic) {
      throw new Error(`TopicCandidate is missing for EpisodeTopic ${et.id}.`);
    }
    const brief = et.topic.researchBrief;
    if (!brief) {
      throw new Error(`ResearchBrief is missing for TopicCandidate ${et.topic.title || et.topic.id}.`);
    }

    const facts = Array.isArray(brief.facts) ? brief.facts : [];
    const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
    if (facts.length === 0) {
      throw new Error(`ResearchBrief for '${et.topic.title}' has empty facts list.`);
    }
    if (sourceIds.length === 0) {
      throw new Error(`ResearchBrief for '${et.topic.title}' has empty sourceIds list.`);
    }
  }

  // 2. Check if a FactCheckResult already exists for the script
  if (!forceRecheck) {
    const existing = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      return existing;
    }
  }

  // 3. Setup Allowed sourceIds, unsafeClaims, and facts/stats texts
  const allowedSourceRefs = new Set<string>();
  const unsafeClaims: string[] = [];
  const allowedFactsAndStats: string[] = [];
  const evidencePanelItems: any[] = [];

  for (const et of script.episode.topics) {
    const brief = et.topic.researchBrief!;
    const sourceIds = Array.isArray(brief.sourceIds) ? (brief.sourceIds as any[]) : [];
    const facts = Array.isArray(brief.facts) ? (brief.facts as any[]) : [];
    const stats = Array.isArray(brief.stats) ? (brief.stats as any[]) : [];

    for (const src of sourceIds) {
      if (src && src.type && src.id) {
        allowedSourceRefs.add(`${src.type}:${src.id}`);

        let detailText = "";
        const matchedFact = facts.find((f) => f.evidenceRefs?.some((ref: any) => ref.id === src.id));
        if (matchedFact) {
          detailText = matchedFact.text;
        } else {
          const matchedStat = stats.find((s) => s.evidenceRefs?.some((ref: any) => ref.id === src.id));
          if (matchedStat) {
            detailText = matchedStat.text;
          }
        }

        evidencePanelItems.push({
          type: src.type,
          id: src.id,
          topicTitle: et.topic.title,
          detailText,
        });
      }
    }

    for (const f of facts) {
      if (f && f.text) allowedFactsAndStats.push(f.text.toLowerCase());
    }
    for (const s of stats) {
      if (s && s.text) allowedFactsAndStats.push(s.text.toLowerCase());
    }
    if (brief.injuryContext) {
      allowedFactsAndStats.push(brief.injuryContext.toLowerCase());
    }
    if (brief.oddsContext) {
      allowedFactsAndStats.push(brief.oddsContext.toLowerCase());
    }

    const unsafe = Array.isArray(brief.unsafeClaims) ? (brief.unsafeClaims as any[]) : [];
    for (const uc of unsafe) {
      if (uc && uc.claim) {
        unsafeClaims.push(uc.claim);
      }
    }
  }

  // 4. Fetch host profiles
  const hostA = await db.aiHost.findFirst({ where: { name: "Max Voltage", isActive: true } });
  const hostB = await db.aiHost.findFirst({ where: { name: "Dr. Linebreak", isActive: true } });
  if (!hostA || !hostB) {
    throw new Error("Active host profiles for Max Voltage and Dr. Linebreak must be active.");
  }

  // 5. Layer 1: Deterministic Checks
  let totalLineCount = 0;
  let factualLineCount = 0;
  let factualLineWithValidEvidenceCount = 0;
  let invalidEvidenceRefCount = 0;
  let unsupportedClaimCount = 0;
  let unsafeClaimCount = 0;
  let rumorLanguageCount = 0;
  let needsHumanReviewCount = 0;
  let invalidSpeakerCount = 0;
  let maxVoltageCount = 0;
  let drLinebreakCount = 0;

  // Semantic issue counters
  let semanticUnsupportedCount = 0;
  let semanticNeedsReviewCount = 0;
  let semanticInvalidEvidenceRefCount = 0;
  let semanticMisleadingCount = 0;
  let semanticUnsafeClaimCount = 0;

  const originalFlatLines: any[] = [];
  const errorsList: any[] = [];
  const warningsList: any[] = [];

  const segments = (script.content as any).segments || [];
  if (!Array.isArray(segments) || segments.length === 0) {
    errorsList.push({ reason: "Script segments array is missing or empty." });
  } else {
    for (let sIdx = 0; sIdx < segments.length; sIdx++) {
      const seg = segments[sIdx];
      if (!seg || typeof seg !== "object" || !Array.isArray(seg.lines)) {
        errorsList.push({ reason: `Segment at index ${sIdx} is invalid or has no lines.` });
        continue;
      }

      for (let lIdx = 0; lIdx < seg.lines.length; lIdx++) {
        const line = seg.lines[lIdx];
        if (!line || typeof line !== "object") {
          errorsList.push({ reason: `Line at segment ${sIdx}, index ${lIdx} is invalid.` });
          continue;
        }

        totalLineCount++;

        originalFlatLines.push({
          lineIndex: line.lineIndex !== undefined ? line.lineIndex : (totalLineCount - 1),
          speakerName: line.speakerName || "",
          text: line.text || "",
        });

        // Required fields verification
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
          errorsList.push({
            type: "invalid_line_structure",
            lineIndex: line.lineIndex || totalLineCount,
            reason: "Dialogue line is missing required schema fields.",
          });
          continue;
        }

        // Validate speaker
        if (line.speakerName !== "Max Voltage" && line.speakerName !== "Dr. Linebreak") {
          invalidSpeakerCount++;
          errorsList.push({
            type: "invalid_speaker",
            lineIndex: line.lineIndex,
            reason: `Speaker name '${line.speakerName}' is not allowed. Only 'Max Voltage' and 'Dr. Linebreak' are valid.`,
          });
        }

        if (line.speakerName === "Max Voltage" && line.speakerHostId !== hostA.id) {
          invalidSpeakerCount++;
          errorsList.push({
            type: "invalid_speaker_host_id",
            lineIndex: line.lineIndex,
            reason: "Max Voltage speakerHostId does not match the active host profile ID.",
          });
        } else if (line.speakerName === "Dr. Linebreak" && line.speakerHostId !== hostB.id) {
          invalidSpeakerCount++;
          errorsList.push({
            type: "invalid_speaker_host_id",
            lineIndex: line.lineIndex,
            reason: "Dr. Linebreak speakerHostId does not match the active host profile ID.",
          });
        }

        if (line.speakerName === "Max Voltage") maxVoltageCount++;
        if (line.speakerName === "Dr. Linebreak") drLinebreakCount++;

        // Validate needsHumanReview flag
        if (line.needsHumanReview === true) {
          needsHumanReviewCount++;
          errorsList.push({
            type: "needs_human_review",
            lineIndex: line.lineIndex,
            reason: "Dialogue line is flagged as requiring human review.",
          });
        }

        // Validate unsafe claims (strip inline audio tags like [laughs] so a
        // tag can never split or mask a banned phrase)
        const textLower = stripAudioTags(String(line.text)).toLowerCase();
        let usesUnsafe = false;
        for (const claim of unsafeClaims) {
          if (textLower.includes(claim.toLowerCase())) {
            usesUnsafe = true;
            break;
          }
        }
        if (usesUnsafe) {
          unsafeClaimCount++;
          errorsList.push({
            type: "unsafe_claim_used",
            lineIndex: line.lineIndex,
            reason: `Factual line uses unsafe claim: "${line.text}".`,
          });
        }

        // Validate prohibited rumor language
        let containsRumor = false;
        let matchedRumorWord = "";
        for (const word of PROHIBITED_KEYWORDS) {
          if (textLower.includes(word)) {
            containsRumor = true;
            matchedRumorWord = word;
            break;
          }
        }
        if (containsRumor && line.isFactualClaim) {
          // Verify exact rumor keyword wording matches brief facts/stats
          const rumorSupported = isRumorPhraseSupported(line.text, matchedRumorWord, allowedFactsAndStats);
          if (!rumorSupported) {
            rumorLanguageCount++;
            errorsList.push({
              type: "prohibited_rumor_language",
              lineIndex: line.lineIndex,
              reason: `Factual line uses rumor phrase '${matchedRumorWord}' which is unsupported by the brief.`,
            });
          }
        }

        // Validate evidence references on all lines
        let hasRefError = false;
        for (const ref of line.evidenceRefs) {
          let refValid = true;
          if (!ref || typeof ref !== "object" || !ref.type || !ref.id) {
            refValid = false;
          } else if (!VALID_EVIDENCE_TYPES.includes(ref.type)) {
            refValid = false;
          } else {
            const refKey = `${ref.type}:${ref.id}`;
            if (!allowedSourceRefs.has(refKey)) {
              refValid = false;
            }
          }

          if (!refValid) {
            invalidEvidenceRefCount++;
            hasRefError = true;
            errorsList.push({
              type: "invalid_evidence_ref",
              lineIndex: line.lineIndex,
              reason: `Evidence ref ${JSON.stringify(ref)} is invalid or not allowed in the episode's briefs.`,
            });
            continue;
          }

          // Resolve against actual database records
          let dbExists = false;
          try {
            if (ref.type === "game") {
              const res = await db.game.findUnique({ where: { id: ref.id } });
              if (res) dbExists = true;
            } else if (ref.type === "newsItem") {
              const res = await db.newsItem.findUnique({ where: { id: ref.id } });
              if (res) dbExists = true;
            } else if (ref.type === "injury") {
              const res = await db.injury.findUnique({ where: { id: ref.id } });
              if (res) dbExists = true;
            } else if (ref.type === "oddsSnapshot") {
              const res = await db.oddsSnapshot.findUnique({ where: { id: ref.id } });
              if (res) dbExists = true;
            } else if (ref.type === "teamStat") {
              const res = await db.teamStat.findUnique({ where: { id: ref.id } });
              if (res) dbExists = true;
            } else if (ref.type === "playerStat") {
              const res = await db.playerStat.findUnique({ where: { id: ref.id } });
              if (res) dbExists = true;
            }
          } catch (dbErr) {
            dbExists = false;
          }

          if (!dbExists) {
            invalidEvidenceRefCount++;
            hasRefError = true;
            errorsList.push({
              type: "db_unresolved_evidence_ref",
              lineIndex: line.lineIndex,
              reason: `Evidence ref '${ref.type}:${ref.id}' does not resolve to an actual database record.`,
            });
          }
        }

        // Factual claim validations
        if (line.isFactualClaim) {
          factualLineCount++;
          if (line.evidenceRefs.length === 0) {
            unsupportedClaimCount++;
            errorsList.push({
              type: "unsupported_factual_claim",
              lineIndex: line.lineIndex,
              reason: "Factual claim has empty evidence references list.",
            });
          } else if (!hasRefError) {
            factualLineWithValidEvidenceCount++;
          }
        }
      }
    }
  }

  const evidenceCoveragePercent =
    factualLineCount > 0 ? Math.round((factualLineWithValidEvidenceCount / factualLineCount) * 100) : 100;

  const maxVoltageShare = totalLineCount > 0 ? Math.round((maxVoltageCount / totalLineCount) * 100) : 0;
  const drLinebreakShare = totalLineCount > 0 ? Math.round((drLinebreakCount / totalLineCount) * 100) : 0;

  // Strict deterministic pass checks
  const deterministicPassed =
    errorsList.length === 0 &&
    evidenceCoveragePercent === 100 &&
    invalidEvidenceRefCount === 0 &&
    unsupportedClaimCount === 0 &&
    unsafeClaimCount === 0 &&
    rumorLanguageCount === 0 &&
    needsHumanReviewCount === 0 &&
    invalidSpeakerCount === 0 &&
    totalLineCount >= 40 &&
    maxVoltageShare >= 25 &&
    drLinebreakShare >= 25 &&
    script.plainText.trim().length > 0;

  // 6. Layer 2: LLM semantic review
  const isStub = process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER;
  let semanticStatus: "passed" | "failed" | "needs_review" = "passed";
  let semanticSummary = "Skipped semantic review because LLM_PROVIDER=stub.";
  let semanticLineResults: any[] = [];
  let providerName = isStub ? "deterministic" : process.env.LLM_PROVIDER || "stub";
  let rawLlmOutput: any = null;

  if (!isStub && deterministicPassed) {
    try {
      const provider = getLLMProvider();
      providerName = provider.name;

      const systemPrompt = `You are a strict fact-checking assistant for a sports debate podcast. Your job is to verify host script lines against the allowed evidence records.
Rules:
1. You must compare every host statement against the facts and stats provided.
2. Identify unsupported claims, overstatements, missing context, or misleading wording.
3. You are NOT allowed to verify using outside knowledge or make up facts.
4. You cannot create new evidence IDs.
5. If the script text cannot be verified by the provided evidence, it must be marked as "unsupported".
6. Return a strict JSON response.`;

      const prompt = `Script dialogue:
${JSON.stringify(script.content)}

Allowed evidence packet:
${JSON.stringify(evidencePanelItems)}

Unsafe claims (strictly disallowed):
${JSON.stringify(unsafeClaims)}

Prohibited phrases:
${JSON.stringify(PROHIBITED_KEYWORDS)}

Run the fact-checking comparison and output the JSON structure containing status, summary, and lineResults.`;

      const jsonSchema = {
        type: "object",
        properties: {
          status: { type: "string", enum: ["passed", "failed", "needs_review"] },
          summary: { type: "string" },
          lineResults: {
            type: "array",
            items: {
              type: "object",
              properties: {
                segmentIndex: { type: "integer" },
                lineIndex: { type: "integer" },
                speakerName: { type: "string" },
                claimText: { type: "string" },
                status: { type: "string", enum: ["supported", "unsupported", "needs_review"] },
                reason: { type: "string" },
                evidenceRefs: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      id: { type: "string" },
                    },
                    required: ["type", "id"],
                  },
                },
                suggestedFix: { type: "string" },
              },
              required: ["segmentIndex", "lineIndex", "speakerName", "claimText", "status", "reason", "evidenceRefs"],
            },
          },
          unsupportedClaims: { type: "array", items: { type: "string" } },
          misleadingClaims: { type: "array", items: { type: "string" } },
          unsafeClaimsUsed: { type: "array", items: { type: "string" } },
          missingEvidence: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        required: [
          "status",
          "summary",
          "lineResults",
          "unsupportedClaims",
          "misleadingClaims",
          "unsafeClaimsUsed",
          "missingEvidence",
          "confidence",
        ],
      };

      const resultObj = await provider.generateStructuredOutput<any>({
        prompt,
        systemPrompt,
        jsonSchema,
      });

      rawLlmOutput = resultObj;

      if (resultObj && typeof resultObj === "object") {
        semanticStatus = resultObj.status || "needs_review";
        semanticSummary = resultObj.summary || "";

        // Process global arrays
        const unsupportedClaims = Array.isArray(resultObj.unsupportedClaims) ? resultObj.unsupportedClaims : [];
        if (unsupportedClaims.length > 0) {
          semanticStatus = "failed";
          for (const claim of unsupportedClaims) {
            errorsList.push({
              type: "semantic_unsupported_claim_global",
              reason: `Semantic global: Unsupported claim: "${claim}"`,
            });
            semanticUnsupportedCount++;
          }
        }

        const unsafeClaimsUsed = Array.isArray(resultObj.unsafeClaimsUsed) ? resultObj.unsafeClaimsUsed : [];
        if (unsafeClaimsUsed.length > 0) {
          semanticStatus = "failed";
          for (const claim of unsafeClaimsUsed) {
            errorsList.push({
              type: "semantic_unsafe_claim_global",
              reason: `Semantic global: Unsafe claim used: "${claim}"`,
            });
            semanticUnsafeClaimCount++;
          }
        }

        const missingEvidence = Array.isArray(resultObj.missingEvidence) ? resultObj.missingEvidence : [];
        if (missingEvidence.length > 0) {
          semanticStatus = "failed";
          for (const item of missingEvidence) {
            errorsList.push({
              type: "semantic_missing_evidence_global",
              reason: `Semantic global: Missing evidence: "${item}"`,
            });
          }
        }

        const misleadingClaims = Array.isArray(resultObj.misleadingClaims) ? resultObj.misleadingClaims : [];
        if (misleadingClaims.length > 0) {
          if (semanticStatus !== "failed") {
            semanticStatus = "needs_review";
          }
          for (const claim of misleadingClaims) {
            warningsList.push({
              type: "semantic_misleading_claim_global",
              reason: `Semantic global: Misleading wording: "${claim}"`,
            });
            semanticMisleadingCount++;
          }
        }

        // Process lineResults to enforce safety rules
        const rawLineResults = Array.isArray(resultObj.lineResults) ? resultObj.lineResults : [];
        for (const lr of rawLineResults) {
          // Enrich with original script speaker and text if the LLM returned empty strings
          const origLine = originalFlatLines.find((ol) => ol.lineIndex === lr.lineIndex);
          if (origLine) {
            if (!lr.speakerName || !lr.speakerName.trim()) {
              lr.speakerName = origLine.speakerName;
            }
            if (!lr.claimText || !lr.claimText.trim()) {
              lr.claimText = origLine.text;
            }
          }

          // Filter out evidence refs outside allowedSourceRefs
          const cleanRefs: any[] = [];
          let lineHasInvalidRef = false;

          const refs = Array.isArray(lr.evidenceRefs) ? lr.evidenceRefs : [];
          for (const ref of refs) {
            let refValid = true;
            if (!ref || typeof ref !== "object" || !ref.type || !ref.id) {
              refValid = false;
            } else if (!VALID_EVIDENCE_TYPES.includes(ref.type)) {
              refValid = false;
            } else {
              const refKey = `${ref.type}:${ref.id}`;
              if (!allowedSourceRefs.has(refKey)) {
                refValid = false;
              }
            }

            if (!refValid) {
              lineHasInvalidRef = true;
              semanticInvalidEvidenceRefCount++;
              errorsList.push({
                type: "semantic_invalid_evidence_ref",
                lineIndex: lr.lineIndex,
                reason: `Semantic review: Line #${(lr.lineIndex || 0) + 1} has invalid evidence reference ${JSON.stringify(ref)}.`,
              });
            } else {
              cleanRefs.push(ref);
            }
          }

          if (lineHasInvalidRef) {
            if (lr.status === "unsupported") {
              semanticStatus = "failed";
            } else {
              if (semanticStatus !== "failed") {
                semanticStatus = "needs_review";
              }
            }
          }

          semanticLineResults.push({
            ...lr,
            evidenceRefs: cleanRefs,
          });

          // Line-level semantic results override top-level LLM status
          if (lr.status === "unsupported") {
            semanticUnsupportedCount++;
            semanticStatus = "failed";
            errorsList.push({
              type: "semantic_unsupported_claim",
              lineIndex: lr.lineIndex,
              reason: `Semantic review: Line #${(lr.lineIndex || 0) + 1} is unsupported. ${lr.reason}`,
            });
          } else if (lr.status === "needs_review") {
            semanticNeedsReviewCount++;
            if (semanticStatus !== "failed") {
              semanticStatus = "needs_review";
            }
            warningsList.push({
              type: "semantic_needs_review_claim",
              lineIndex: lr.lineIndex,
              reason: `Semantic review suspect: Line #${(lr.lineIndex || 0) + 1} needs review. ${lr.reason}`,
            });
          }
        }
      } else {
        semanticStatus = "needs_review";
        semanticSummary = "LLM returned invalid structured format. Semantic review flagged as needs_review.";
      }
    } catch (err: any) {
      semanticStatus = "needs_review";
      semanticSummary = `Semantic review failed during execution: ${err.message}`;
    }
  }

  // 7. Resolve Final status mapping
  let finalStatus: "passed" | "failed" | "needs_review" = "passed";

  const hasSemanticFailure =
    semanticStatus === "failed" ||
    semanticUnsupportedCount > 0 ||
    semanticUnsafeClaimCount > 0 ||
    semanticInvalidEvidenceRefCount > 0;

  const hasSemanticReviewNeeded =
    semanticStatus === "needs_review" ||
    semanticNeedsReviewCount > 0 ||
    semanticMisleadingCount > 0;

  if (!deterministicPassed || hasSemanticFailure) {
    finalStatus = "failed";
  } else if (hasSemanticReviewNeeded) {
    finalStatus = "needs_review";
  } else {
    finalStatus = "passed";
  }

  const passedBool = finalStatus === "passed";

  // Organize metrics JSON
  const evidenceCoverage = {
    totalLineCount,
    factualLineCount,
    factualLineWithValidEvidenceCount,
    evidenceCoveragePercent,
    invalidEvidenceRefCount,
    unsupportedClaimCount,
    unsafeClaimCount,
    rumorLanguageCount,
    needsHumanReviewCount,
    invalidSpeakerCount,
    hostLineShare: {
      "Max Voltage": maxVoltageShare,
      "Dr. Linebreak": drLinebreakShare,
    },
    semanticUnsupportedCount,
    semanticNeedsReviewCount,
    semanticInvalidEvidenceRefCount,
    semanticMisleadingCount,
    semanticUnsafeClaimCount,
  };

  const summaryData = {
    totalErrors: errorsList.length,
    totalWarnings: warningsList.length,
    deterministicPassed,
    semanticStatus,
    semanticSummary,
    checkedAt: new Date().toISOString(),
    semanticUnsupportedCount,
    semanticNeedsReviewCount,
    semanticInvalidEvidenceRefCount,
    semanticMisleadingCount,
    semanticUnsafeClaimCount,
  };

  const issuesData = {
    errors: errorsList,
    warnings: warningsList,
    semanticLineResults,
    semanticUnsupportedCount,
    semanticNeedsReviewCount,
    semanticInvalidEvidenceRefCount,
    semanticMisleadingCount,
    semanticUnsafeClaimCount,
  };

  // 8. Atomic database transaction updating statuses
  const result = await db.$transaction(async (tx) => {
    // Create new FactCheckResult record
    const r = await tx.factCheckResult.create({
      data: {
        scriptId,
        passed: passedBool,
        warnings: warningsList as any,
        errors: errorsList as any,
        episodeId: script.episodeId,
        status: finalStatus,
        checkedAt: new Date(),
        provider: providerName,
        summary: summaryData as any,
        issues: issuesData as any,
        evidenceCoverage: evidenceCoverage as any,
        rawResult: (rawLlmOutput || {}) as any,
      },
    });

    if (finalStatus === "passed") {
      // Only change episode status if the script was already approved
      if (script.status === "approved") {
        await tx.episode.update({
          where: { id: script.episodeId },
          data: { status: "fact_checked" },
        });
      }
    } else if (finalStatus === "failed") {
      // Set Script.status = needs_revision
      await tx.script.update({
        where: { id: scriptId },
        data: { status: "needs_revision" },
      });

      // Find if another approved + passed script exists for the episode
      const otherApprovedPassed = await tx.script.count({
        where: {
          episodeId: script.episodeId,
          status: "approved",
          NOT: { id: scriptId },
          factCheckResults: {
            some: {
              status: "passed",
            },
          },
        },
      });

      const nextEpStatus = otherApprovedPassed > 0 ? "fact_checked" : "script_draft";

      await tx.episode.update({
        where: { id: script.episodeId },
        data: { status: nextEpStatus },
      });
    } else if (finalStatus === "needs_review") {
      // Only change episode status if the script was already approved
      if (script.status === "approved") {
        await tx.episode.update({
          where: { id: script.episodeId },
          data: { status: "script_approved" },
        });
      }
    }

    return r;
  });

  return result;
}
