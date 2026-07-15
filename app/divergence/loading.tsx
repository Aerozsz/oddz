import { Skeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Skeleton className="h-8 w-72" />
        <Skeleton className="mt-2 h-4 w-96" />
      </div>
      <TableSkeleton rows={8} />
    </div>
  );
}
