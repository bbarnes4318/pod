import { db } from "@/lib/db";
import { getVerifyLLMProvider, resolveVerifyLLMConfig } from "@/lib/providers/llm/factory";
import { withLlmStage } from "@/lib/providers/llm/costLedger";
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
  runSemanticReview,
} from "./semanticReview";
import { verifyLineAgainstEvidence } from "./factNumbers";
import { collectReviewerEvidence, toEvidencePanel, evidenceFingerprint } from "./evidenceContext";
import { resolveEpisodeTopicContent, briefLikeFromContent } from "./topicSnapshot";

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

  // Verify all linked topics carry facts + sourceIds — from the immutable
  // snapshot when present (fact-checking must judge the script against the SAME
  // evidence it was generated from, not a later-edited live brief), else live.
  for (const et of script.episode.topics) {
    const content = resolveEpisodeTopicContent(et as any);
    const facts = Array.isArray(content.facts) ? content.facts : [];
    const sourceIds = Array.isArray(content.sourceIds) ? content.sourceIds : [];
    if (facts.length === 0) {
      throw new Error(`Topic '${content.title}' has empty facts list.`);
    }
    if (sourceIds.length === 0) {
      throw new Error(`Topic '${content.title}' has empty sourceIds list.`);
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
    const content = resolveEpisodeTopicContent(et as any);
    const brief: any = briefLikeFromContent(content);
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
          topicTitle: content.title,
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

  // FIX 1 setup: per-ref evidence text (id -> the fact/stat text that cited it)
  // and the episode's full evidence corpus, for number-in-evidence verification.
  const refIdToText = new Map<string, string>();
  for (const item of evidencePanelItems) {
    if (item && item.id) {
      const prev = refIdToText.get(item.id) || "";
      refIdToText.set(item.id, `${prev} ${item.detailText || ""}`.trim());
    }
  }
  const fullEvidenceText = [
    ...allowedFactsAndStats,
    ...evidencePanelItems.map((i) => i.detailText || ""),
  ].join("  ");

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
  // FIX 1: figures a factual line asserts that don't appear in its evidence.
  let unsupportedFigureCount = 0;
  // FIX 2: fabricated quotes/actions attributed to named real people.
  let unsupportedAttributionCount = 0;
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

            // FIX 1 — number-in-evidence + attribution verification. A ref
            // proves the line CITES real evidence; it does not prove the line's
            // FIGURES or person-ATTRIBUTIONS match that evidence. Uses the same
            // verifier the generation-time self-verify loop uses, so gate and
            // generator agree exactly. No evidence text => degrade to semantic.
            const citedText = line.evidenceRefs
              .map((r: any) => refIdToText.get(r?.id) || "")
              .join("  ");
            const v = verifyLineAgainstEvidence(String(line.text), citedText, fullEvidenceText, [hostA.name, hostB.name]);

            for (const f of v.unsupportedFigures) {
              unsupportedFigureCount++;
              const says = f.evidenceSays.length ? f.evidenceSays.join(", ") : "no matching figure";
              errorsList.push({
                type: "unsupported_figure",
                lineIndex: line.lineIndex,
                reason: `Line #${line.lineIndex + 1} asserts "${f.surface}" (${f.value}) but the cited evidence does not contain it (evidence numbers: ${says}). Stated figures must appear in the evidence.`,
              });
            }
            for (const n of v.unsupportedAttributions) {
              unsupportedAttributionCount++;
              errorsList.push({
                type: "unsupported_attribution",
                lineIndex: line.lineIndex,
                reason: `Line #${line.lineIndex + 1} attributes a specific quote/statement/action to "${n}", who does not appear in the cited evidence. Fabricated attributions to named people are prohibited.`,
              });
            }
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

  // 6. Layer 2: LLM semantic review. Runs on the VERIFY model (structured
  // grading against supplied evidence — not creative work): VERIFY_LLM_* >
  // the factcheck chain (FACTCHECK_LLM_* > SCRIPT_LLM_* > LLM_PROVIDER),
  // defaulting to claude-sonnet-5 on Anthropic chains. Stub only when the
  // whole chain is unset.
  const llmConfig = resolveVerifyLLMConfig();
  const isStub = llmConfig.provider === "stub";
  const llmLabel = llmConfig.model ? `${llmConfig.provider}/${llmConfig.model}` : llmConfig.provider;
  let semanticStatus: "passed" | "failed" | "needs_review" = "passed";
  let semanticSummary = isStub
    ? "Skipped semantic review: no LLM provider configured (FACTCHECK_LLM_PROVIDER, SCRIPT_LLM_PROVIDER, and LLM_PROVIDER are all unset or 'stub')."
    : `Semantic review (${llmLabel}) skipped because deterministic checks failed.`;
  let semanticLineResults: any[] = [];
  let providerName = isStub ? "deterministic" : llmLabel;
  let rawLlmOutput: any = null;
  let reviewerEvidenceFingerprint: { count: number; chars: number } | null = null;

  // Which lines the semantic reviewer is even allowed to fail: only genuine
  // factual claims. This map is the authoritative server-side guard — the model
  // is instructed to skip non-factual lines, but we never trust it to obey.
  const factualByIndex = new Map<number, boolean>();
  for (const ol of originalFlatLines) factualByIndex.set(ol.lineIndex, ol.isFactualClaim === true);

  if (!isStub && deterministicPassed) {
    try {
      const provider = getVerifyLLMProvider();

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

      // Reuse the shared reviewer AND the shared evidence corpus, so the gate
      // reviewer sees byte-identical evidence to the generation-time self-verify
      // reviewer (previously the gate saw only ~1 fact per ref — a plumbing bug
      // that made it false-flag facts it was never shown). The sourceId-based
      // `evidencePanelItems` above is kept for the deterministic number check.
      const reviewerEvidence = collectReviewerEvidence(
        script.episode.topics.map((et) => ({ researchBrief: briefLikeFromContent(resolveEpisodeTopicContent(et as any)) }))
      );
      const reviewerPanel = toEvidencePanel(reviewerEvidence.evidenceTexts);
      reviewerEvidenceFingerprint = evidenceFingerprint(reviewerEvidence.evidenceTexts);
      console.log(`[FactCheck] reviewer evidence: ${JSON.stringify(reviewerEvidenceFingerprint)}`);

      const resultObj = await withLlmStage("factcheck:semantic-review", () =>
        runSemanticReview(provider, {
          reviewLines,
          evidencePanelItems: reviewerPanel,
          unsafeClaims,
          rumorKeywords: RUMOR_KEYWORDS,
        })
      );

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

  // ---- Fact-check policy: "warnings, hard-gate at publish" ----
  // Grounding gaps are recorded but no longer fail the check: a factual line
  // with no citation, sub-100% evidence coverage, an invalid ref, rumor
  // phrasing, a needs-human-review flag, and the semantic reviewer's
  // unsupported / misleading / needs-review / invalid-ref verdicts are all
  // WARNINGS (kept in warningsList + evidenceCoverage metrics, surfaced in the
  // transcript step). Only genuine SAFETY (a deterministic OR LLM-flagged
  // unsafe claim) and STRUCTURAL problems (invalid host casting, too-short or
  // unbalanced script, empty transcript) hard-fail here. The hard publish gate
  // (validateEpisodeForRss / attemptPublish) remains the compliance stop that
  // blocks an episode from going live on unresolved claims.
  const hasUnsafeContent = unsafeClaimCount > 0 || semanticUnsafeClaimCount > 0;
  const hasStructuralFailure =
    invalidSpeakerCount > 0 ||
    totalLineCount < 40 ||
    hostAShare < 25 ||
    hostBShare < 25 ||
    script.plainText.trim().length === 0;

  finalStatus = hasUnsafeContent || hasStructuralFailure ? "failed" : "passed";

  const passedBool = finalStatus === "passed";

  // Organize metrics JSON
  const evidenceCoverage = {
    totalLineCount,
    factualLineCount,
    factualLineWithValidEvidenceCount,
    evidenceCoveragePercent,
    invalidEvidenceRefCount,
    unsupportedClaimCount,
    unsupportedFigureCount,
    unsupportedAttributionCount,
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
    reviewerEvidenceFingerprint,
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
