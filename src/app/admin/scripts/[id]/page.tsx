import React from "react";
import ScriptReviewView from "./ScriptReviewView";
import { db } from "@/lib/db";
import "../scripts.css";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ScriptReviewDetailPage({ params }: PageProps) {
  const { id } = await params;

  // Load the script
  const script = await db.script.findUnique({
    where: { id },
    include: {
      episode: {
        include: {
          topics: {
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
    notFound();
  }

  // Load hosts Max Voltage and Dr. Linebreak
  const hostA = await db.aiHost.findFirst({ where: { name: "Max Voltage", isActive: true } });
  const hostB = await db.aiHost.findFirst({ where: { name: "Dr. Linebreak", isActive: true } });

  if (!hostA || !hostB) {
    return (
      <div className="panel" style={{ padding: "4rem", textAlign: "center" }}>
        <p style={{ color: "#ef4444", fontSize: "1.1rem", margin: 0 }}>
          Missing Host Profiles: Active profiles for 'Max Voltage' and 'Dr. Linebreak' must exist to review scripts.
        </p>
      </div>
    );
  }

  // Extract allowed refs & unsafe claims
  const allowedSourceRefs = new Set<string>();
  const unsafeClaims: string[] = [];
  const evidencePanelItems: any[] = [];

  for (const et of script.episode.topics) {
    const brief = et.topic.researchBrief;
    if (brief) {
      const facts = Array.isArray(brief.facts) ? (brief.facts as any[]) : [];
      const stats = Array.isArray(brief.stats) ? (brief.stats as any[]) : [];
      const sourceIds = Array.isArray(brief.sourceIds) ? (brief.sourceIds as any[]) : [];

      for (const src of sourceIds) {
        if (src && src.id && src.type) {
          allowedSourceRefs.add(`${src.type}:${src.id}`);

          // Find fact/stat text
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

      const unsafe = Array.isArray(brief.unsafeClaims) ? (brief.unsafeClaims as any[]) : [];
      for (const uc of unsafe) {
        if (uc && uc.claim) {
          unsafeClaims.push(uc.claim);
        }
      }
    }
  }

  // Serialized data structures
  const serializedScript = {
    id: script.id,
    episodeId: script.episodeId,
    version: script.version,
    content: typeof script.content === "object" && script.content !== null ? (script.content as any) : {},
    plainText: script.plainText,
    status: script.status,
    createdAt: script.createdAt.toISOString(),
  };

  const serializedEpisode = {
    id: script.episode.id,
    title: script.episode.title,
    status: script.episode.status,
  };

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      <ScriptReviewView
        script={serializedScript}
        episode={serializedEpisode}
        evidencePanelItems={evidencePanelItems}
        hostA={{ id: hostA.id, name: hostA.name }}
        hostB={{ id: hostB.id, name: hostB.name }}
        unsafeClaims={unsafeClaims}
      />
    </div>
  );
}
