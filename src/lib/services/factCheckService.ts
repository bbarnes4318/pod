import { db } from "@/lib/db";
import { getFactCheckLLMProvider, resolveFactCheckLLMConfig } from "@/lib/providers/llm/factory";
import { stripAudioTags } from "@/lib/audio/speechText";
import { resolveEpisodeHosts, makeSpeakerMatchers } from "@/lib/services/hostCasting";
import {
  RUMOR_KEYWORDS,
  findRumorKeyword,
  findSpeculationKeyword,
  isGenuineFactualAssertion,
} from "./claimLanguage";
import {
  isFragmentLine,
  mostSevereStatus,
  processSemanticLineResults,
} from "./semanticReview";

const VALID_EVIDENCE_TYPES = [
  "game",
  "newsItem",
  "injury",
  "oddsSnapshot",
  "teamStat",
  "playerStat",
  "research",
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

  // 4. Resolve the two hosts this episode was cast with (no hardcoded names).
  const { hostA, hostB } = await resolveEpisodeHosts({ hostIds: script.episode.hostIds });
  const speakers = makeSpeakerMatchers({ hostA, hostB });

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
  const lineCountByHostId = new Map<string, number>([
    [hostA.id, 0],
    [hostB.id, 0],
  ]);

  // Semantic issue counters
  let semanticUnsupportedCount = 0;
  let semanticNeedsReviewCount = 0;
  let semanticInvalidEvidenceRefCount = 0;
  let semanticMisleadingCount = 0;
  let semanticUnsafeClaimCount = 0;
  // Non-factual line verdicts the reviewer returned that we ignore by design
  // (the semantic layer judges only isFactualClaim:true lines), and flags the
  // reviewer returned with no usable rationale (discarded as parse errors, so a
  // reason-less verdict never fails a script).
  let semanticSkippedNonFactualCount = 0;
  let semanticParseErrorCount = 0;

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
          // Conversational context for the semantic reviewer (STEP 1/3): the
          // authoritative isFactualClaim flag (already required + trusted by the
          // deterministic layer) plus tone/interruption/fragment cues so banter,
          // reactions, intros, and cut-off lines are never fact-checked.
          isFactualClaim: line.isFactualClaim === true,
          tone: line.tone,
          isInterruption: line.isInterruption === true,
          isFragment: isFragmentLine(line.text),
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

        // Validate speaker against this episode's cast.
        const lineHost = speakers.hostForSpeaker(line.speakerName);
        if (!lineHost) {
          invalidSpeakerCount++;
          errorsList.push({
            type: "invalid_speaker",
            lineIndex: line.lineIndex,
            reason: `Speaker name '${line.speakerName}' is not allowed. Only '${hostA.name}' and '${hostB.name}' are valid.`,
          });
        } else {
          if (line.speakerHostId !== lineHost.id) {
            invalidSpeakerCount++;
            errorsList.push({
              type: "invalid_speaker_host_id",
              lineIndex: line.lineIndex,
              reason: `${lineHost.name} speakerHostId does not match the cast host profile ID.`,
            });
          }
          lineCountByHostId.set(lineHost.id, (lineCountByHostId.get(lineHost.id) ?? 0) + 1);
        }

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

        // Fact vs opinion: ref-less lines in clear opinion/prediction
        // framing are treated as opinion even when the writer marked them
        // isFactualClaim — speculation is the debate format, not a claim.
        const isGenuineFactual = isGenuineFactualAssertion(line, textLower);

        // Fabricated-sourcing language ("sources say", "reportedly", ...) is
        // hard-prohibited on EVERY line unless the brief itself supports the
        // phrasing (e.g. an injury report the research actually contains).
        const rumorWord = findRumorKeyword(textLower);
        if (rumorWord && !isRumorPhraseSupported(line.text, rumorWord, allowedFactsAndStats)) {
          rumorLanguageCount++;
          errorsList.push({
            type: "prohibited_rumor_language",
            lineIndex: line.lineIndex,
            reason: `Line uses fabricated-sourcing phrase '${rumorWord}' which is unsupported by the brief.`,
          });
        }

        // Speculative hedging ("expected to", "could be", ...) is normal
        // debate speech. It is only suspect when a line PRESENTS it as fact
        // (genuine factual assertion) and the brief doesn't back the
        // phrasing — e.g. inventing an injury timeline.
        if (!rumorWord && isGenuineFactual) {
          const specWord = findSpeculationKeyword(textLower);
          if (specWord && !isRumorPhraseSupported(line.text, specWord, allowedFactsAndStats)) {
            rumorLanguageCount++;
            errorsList.push({
              type: "prohibited_rumor_language",
              lineIndex: line.lineIndex,
              reason: `Factual line uses speculative phrase '${specWord}' which is unsupported by the brief.`,
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

          // Resolve against actual database records. "research" refs are the
          // exception: they are Exa web-research entries that live only inside
          // the episode's ResearchBrief JSON (ids like "research-1") — there is
          // no DB table for them. The allowedSourceRefs check above already
          // resolved them against the same id space the script was given, so
          // they count as resolved here.
          let dbExists = false;
          try {
            if (ref.type === "research") {
              dbExists = true;
            } else if (ref.type === "game") {
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

        // Factual claim validations — coverage counts only genuine factual
        // assertions, so opinion lines can't tank the percentage.
        if (isGenuineFactual) {
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

  const hostAShare = totalLineCount > 0 ? Math.round(((lineCountByHostId.get(hostA.id) ?? 0) / totalLineCount) * 100) : 0;
  const hostBShare = totalLineCount > 0 ? Math.round(((lineCountByHostId.get(hostB.id) ?? 0) / totalLineCount) * 100) : 0;

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
    hostAShare >= 25 &&
    hostBShare >= 25 &&
    script.plainText.trim().length > 0;

  // 6. Layer 2: LLM semantic review. Provider resolves like the script path:
  // FACTCHECK_LLM_* > SCRIPT_LLM_* > LLM_PROVIDER — stub only when NONE are set,
  // so the checker runs on the same strong model that wrote the script.
  const llmConfig = resolveFactCheckLLMConfig();
  const isStub = llmConfig.provider === "stub";
  const llmLabel = llmConfig.model ? `${llmConfig.provider}/${llmConfig.model}` : llmConfig.provider;
  let semanticStatus: "passed" | "failed" | "needs_review" = "passed";
  let semanticSummary = isStub
    ? "Skipped semantic review: no LLM provider configured (FACTCHECK_LLM_PROVIDER, SCRIPT_LLM_PROVIDER, and LLM_PROVIDER are all unset or 'stub')."
    : `Semantic review (${llmLabel}) skipped because deterministic checks failed.`;
  let semanticLineResults: any[] = [];
  let providerName = isStub ? "deterministic" : llmLabel;
  let rawLlmOutput: any = null;

  // Which lines the semantic reviewer is even allowed to fail: only genuine
  // factual claims. This map is the authoritative server-side guard — the model
  // is instructed to skip non-factual lines, but we never trust it to obey.
  const factualByIndex = new Map<number, boolean>();
  for (const ol of originalFlatLines) factualByIndex.set(ol.lineIndex, ol.isFactualClaim === true);

  if (!isStub && deterministicPassed) {
    try {
      const provider = getFactCheckLLMProvider();

      // Give the reviewer each line already classified, with the conversational
      // context (tone / interruption / fragment) that identifies banter — rather
      // than the raw script JSON with no guidance on what to skip.
      const reviewLines = originalFlatLines.map((ol) => ({
        lineIndex: ol.lineIndex,
        speakerName: ol.speakerName,
        text: ol.text,
        isFactualClaim: ol.isFactualClaim === true,
        tone: ol.tone,
        isInterruption: ol.isInterruption === true,
        isFragment: ol.isFragment === true,
      }));

      const systemPrompt = `You are a strict fact-checking assistant for a sports DEBATE podcast. The show format is two hosts arguing: hot takes, predictions, and judgments are the product, not violations. Your job is to verify FACTUAL ASSERTIONS against the allowed evidence records — not to demand citations for opinions.

Each line is PRE-CLASSIFIED with an "isFactualClaim" flag plus "tone", "isInterruption", and "isFragment" context. Honor them.

A FACTUAL CLAIM is a specific, checkable assertion about the world: a stat, score, record, date, result, standing, streak, transaction, injury, or an attribution/quote presented as true. Everything else is not a claim.

Rules:
1. ONLY evaluate lines where isFactualClaim is true. For every one of those, verify it against the provided facts and stats and identify unsupported claims, overstatements, missing context, or misleading wording of real evidence.
2. Non-factual lines (isFactualClaim false) are supported by default — never flag them. This includes rhetorical questions, exclamations, reactions, concessions, hot takes, predictions, jokes, the show intro/outro, interruptions (isInterruption true), and incomplete or cut-off sentences (isFragment true, or text ending in a dash "—"). Opinions and fragments are not verifiable and that is fine.
3. Fabricated sourcing ("sources say", "reportedly", "rumored", "insiders", "unnamed source") is prohibited on ANY line unless the provided evidence itself contains that reporting.
4. You are NOT allowed to verify using outside knowledge or make up facts. You cannot create new evidence IDs.
5. MANDATORY RATIONALE: for every line you mark "unsupported" or "needs_review", the "reason" field MUST be a specific, non-empty explanation that quotes the exact claim and says why the evidence does not support it. A verdict with an empty or missing reason is invalid and will be discarded — do not emit one.
6. OUTPUT ONLY PROBLEMS: return a lineResults entry ONLY for lines you mark "unsupported" or "needs_review". Do NOT emit an entry for any "supported" line — omit them entirely. A line absent from lineResults is treated as supported. This keeps the response small; emitting all lines can truncate it and fail the whole review.
7. Return a strict JSON response.`;

      const prompt = `Script dialogue — each line is pre-classified. Evaluate ONLY lines with isFactualClaim:true. Return a lineResults entry ONLY for lines you flag as unsupported or needs_review — omit every supported line:
${JSON.stringify(reviewLines)}

Allowed evidence packet:
${JSON.stringify(evidencePanelItems)}

Unsafe claims (strictly disallowed):
${JSON.stringify(unsafeClaims)}

Prohibited fabricated-sourcing phrases (banned unless the evidence packet itself contains that reporting):
${JSON.stringify(RUMOR_KEYWORDS)}

Reminder: predictive hedging ("expected to", "likely to", "could be", "might be") is NORMAL debate speech on opinion/prediction lines — never a violation by itself.

Run the fact-checking comparison and output the JSON structure containing status, summary, and lineResults (flagged lines only).`;

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
        // The model's top-level status is ADVISORY only — recorded in the
        // summary, but never a pass/fail driver on its own. A bare "failed" with
        // no auditable line/global finding (e.g. it reacted to banter it should
        // have skipped) must not sink a script. The decision is raised to
        // needs_review / failed below solely by server-verified, rationale-backed
        // findings.
        const modelStatus = resultObj.status || "needs_review";
        semanticStatus = "passed";
        semanticSummary =
          (resultObj.summary || "") + (modelStatus !== "passed" ? ` [model top-level status: ${modelStatus}]` : "");

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

        // Process lineResults — scope to factual claims + enforce rationale.
        const rawLineResults = Array.isArray(resultObj.lineResults) ? resultObj.lineResults : [];
        const lineOutput = processSemanticLineResults({
          rawLineResults,
          factualByIndex,
          allowedSourceRefs,
          originalFlatLines,
          validEvidenceTypes: VALID_EVIDENCE_TYPES,
        });
        errorsList.push(...lineOutput.errors);
        warningsList.push(...lineOutput.warnings);
        semanticLineResults.push(...lineOutput.semanticLineResults);
        semanticUnsupportedCount += lineOutput.counts.unsupported;
        semanticNeedsReviewCount += lineOutput.counts.needsReview;
        semanticInvalidEvidenceRefCount += lineOutput.counts.invalidEvidenceRef;
        semanticSkippedNonFactualCount += lineOutput.counts.skippedNonFactual;
        semanticParseErrorCount += lineOutput.counts.parseError;
        semanticStatus = mostSevereStatus(semanticStatus, lineOutput.status);
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
      [hostA.name]: hostAShare,
      [hostB.name]: hostBShare,
    },
    semanticUnsupportedCount,
    semanticNeedsReviewCount,
    semanticInvalidEvidenceRefCount,
    semanticMisleadingCount,
    semanticUnsafeClaimCount,
    semanticSkippedNonFactualCount,
    semanticParseErrorCount,
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
    semanticSkippedNonFactualCount,
    semanticParseErrorCount,
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
    semanticSkippedNonFactualCount,
    semanticParseErrorCount,
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
