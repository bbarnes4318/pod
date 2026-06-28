import React from "react";
import { fetchFinalAudioDetail } from "../actions";
import FinalAudioConsole from "./FinalAudioConsole";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ scriptId: string }>;
}

export default async function FinalAudioDetailPage({ params }: PageProps) {
  const { scriptId } = await params;
  const res = await fetchFinalAudioDetail(scriptId);

  if (!res.success || !res.detail) {
    notFound();
  }

  return <FinalAudioConsole initialDetail={res.detail} />;
}
