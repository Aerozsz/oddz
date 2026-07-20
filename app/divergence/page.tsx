import { DivergenceTable } from "@/features/divergence/components/DivergenceTable";
import { EdgeFallback } from "@/features/markets/components/EdgeFallback";
import { PageHeader } from "@/features/layout/PageHeader";
import { listDivergences } from "@/features/divergence/queries";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export default async function DivergencePage() {
  const rows = await listDivergences(50);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Divergence"
        context={<>{rows.length} linked events</>}
        blurb={<>Same event, different venues, different YES prices. Larger spread = larger relative-value gap.</>}
      />
      {rows.length === 0 ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            No matched events across venues yet — divergences appear once the matcher links the
            same question on two venues.
          </p>
          <EdgeFallback />
        </div>
      ) : (
        <DivergenceTable rows={rows} />
      )}
    </div>
  );
}
