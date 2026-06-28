import React from "react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import HostForm from "../HostForm";
import "../personalities.css";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditHostPage({ params }: EditPageProps) {
  const { id } = await params;

  const host = await db.aiHost.findUnique({
    where: { id },
  });

  if (!host) {
    notFound();
  }

  return (
    <div className="formContainer">
      <HostForm initialData={host} />
    </div>
  );
}
