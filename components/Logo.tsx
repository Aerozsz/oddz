import Link from "next/link";
import { SITE } from "@/lib/site";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 rounded-lg font-semibold text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600">
        <svg viewBox="0 0 64 64" className="h-5 w-5"><path d="M18 44V20h6v24zm11 0V28h6v16zm11 0V14h6v30z" fill="#fff" /></svg>
      </span>
      <span>{SITE.name}</span>
    </Link>
  );
}
