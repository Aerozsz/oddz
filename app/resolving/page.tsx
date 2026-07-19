import { listResolvingSoon } from "@/features/markets/queries";
import { PageHeader } from "@/features/layout/PageHeader";
import { ResolvingBoard, type ResolvingItem } from "@/features/resolving/ResolvingBoard";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Resolving soon",
  description: "Prediction markets closest to resolution, across every venue.",
};

export default async function ResolvingPage() {
  const rows = await listResolvingSoon(80);
  const items: ResolvingItem[] = rows
    .filter((r) => r.endsAt)
    .map((r) => ({
      id: r.id,
      question: r.question,
      category: r.category,
      venue: r.venue,
      venueName: r.venueName,
      yes: r.prices?.[0] ?? null,
      endsAt: new Date(r.endsAt as Date).toISOString(),
    }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Resolving"
        blurb={<>Markets closest to settlement — where the clock creates the edge. Timers count down live.</>}
      />
      <ResolvingBoard items={items} />
    </div>
  );
}
