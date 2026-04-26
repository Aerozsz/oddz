import { DivergenceTable } from "@/features/divergence/components/DivergenceTable";
import { listDivergences } from "@/features/divergence/queries";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export default async function DivergencePage() {
  const rows = await listDivergences(50);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cross-venue divergence</h1>
        <p className="text-sm text-zinc-500">
          Same event, different venues, different YES prices. Larger spread = larger relative-value gap.
        </p>
      </div>
      <DivergenceTable rows={rows} />
    </div>
  );
}
