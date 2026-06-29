import React from "react";
import { notFound } from "next/navigation";
import { fetchRssDetail, fetchRssEligibility, fetchLatestRssJob } from "../actions";
import RssDetailConsole from "./RssDetailConsole";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{
    scriptId: string;
  }>;
}

export default async function RssDetailPage({ params }: PageProps) {
  const resolvedParams = await params;
  const scriptId = resolvedParams.scriptId;

  const script = await fetchRssDetail(scriptId);

  if (!script || !script.episode) {
    notFound();
  }

  const eligibility = await fetchRssEligibility(scriptId);
  const latestJob = await fetchLatestRssJob(scriptId);
  const previewToken = process.env.RSS_PREVIEW_TOKEN || "super-secret-preview-token";

  return (
    <RssDetailConsole
      script={script}
      initialEligibility={eligibility}
      initialJob={latestJob}
      previewToken={previewToken}
    />
  );
}
