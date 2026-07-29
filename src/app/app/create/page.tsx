import { redirect } from "next/navigation";

export default async function LegacyCreatePage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic } = await searchParams;
  redirect(topic ? `/studio/create?topic=${encodeURIComponent(topic)}` : "/studio/create");
}
