import React from "react";
import { notFound } from "next/navigation";
import { fetchContentAssetDetail, fetchContentAssetEligibility } from "../actions";
import ContentAssetConsole from "./ContentAssetConsole";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ scriptId: string }>;
}

export default async function ContentAssetDetailPage({ params }: PageProps) {
  const { scriptId } = await params;

  const detailRes = await fetchContentAssetDetail(scriptId);
  const eligibilityRes = await fetchContentAssetEligibility(scriptId);

  if (!detailRes.success || !detailRes.detail) {
    notFound();
  }

  return (
    <ContentAssetConsole
      initialDetail={detailRes.detail}
      initialEligibility={eligibilityRes.success && eligibilityRes.checks ? eligibilityRes : null}
    />
  );
}
