import React from "react";
import { notFound } from "next/navigation";
import StudioPageHeader from "../../../StudioPageHeader";
import { requireUserPage } from "@/lib/currentUser";
import { businessPodcastsEnabledFor } from "@/lib/business/intelligenceType";
import BusinessSetupForm from "./BusinessSetupForm";

export const dynamic = "force-dynamic";

export default async function NewBusinessShowPage() {
  const user = await requireUserPage("/studio/shows/new/business");
  if (!businessPodcastsEnabledFor(user)) notFound();
  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Business podcast"
        subtitle="Discover what your industry's audience wants to know and create podcasts powered by deep research."
        breadcrumb={[{ label: "Shows", href: "/studio/shows" }, { label: "New", href: "/studio/shows/new" }]}
      />
      <BusinessSetupForm />
    </div>
  );
}
