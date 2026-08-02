import React from "react";
import LearningDashboard from "./LearningDashboard";
import { fetchLearningData } from "./actions";

export const dynamic = "force-dynamic";

export default async function LearningPage() {
  const data = await fetchLearningData(null);
  return <LearningDashboard initial={data} />;
}
