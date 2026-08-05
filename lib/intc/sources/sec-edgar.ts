import { z } from "zod";
import { fetchJson } from "../../http";
import type { FetchNewsOptions, NewsSource, RawNewsItem, Severity } from "../types";

/**
 * SEC EDGAR filings for Intel Corporation (CIK 0000050863). This is the
 * primary-source, no-spin channel: an 8-K "Material Definitive Agreement"
 * hits EDGAR minutes after Intel files it, often *before* the wires write it
 * up. In the foundry era, a material agreement is exactly the shape of a
 * customer/anchor deal — so we surface Intel's 8-Ks even when the one-line
 * metadata doesn't say "foundry" (the angle is usually in the filing body).
 *
 * EDGAR's submissions JSON is column-oriented (parallel arrays); we zip the
 * columns we care about back into rows.
 */
const CIK = "0000050863";
const CIK_NUM = "50863"; // no leading zeros for the Archives path

const Submissions = z.object({
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      filingDate: z.array(z.string()),
      reportDate: z.array(z.string()).optional(),
      form: z.array(z.string()),
      primaryDocument: z.array(z.string()),
      primaryDocDescription: z.array(z.string()).optional(),
      items: z.array(z.string()).optional(),
    }),
  }),
});

// Forms worth waking up for. Periodic reports (10-K/10-Q) carry the foundry
// segment P&L; 8-Ks carry material events (agreements, guidance, departures).
const MATERIAL_FORMS = new Set(["8-K", "8-K/A", "10-Q", "10-K", "10-K/A"]);

// EDGAR 8-K item codes that matter most for the foundry thesis.
const HOT_ITEMS = new Set([
  "1.01", // Entry into a Material Definitive Agreement
  "1.02", // Termination of a Material Definitive Agreement
  "2.02", // Results of Operations
  "2.05", // Costs from Exit/Disposal (restructuring)
  "2.06", // Material Impairments
]);

function itemFloor(form: string, items: string | undefined): Severity {
  if (form.startsWith("8-K")) {
    const codes = (items ?? "").split(/[,\s]+/).filter(Boolean);
    if (codes.some((c) => HOT_ITEMS.has(c))) return "high";
    return "medium";
  }
  return "medium"; // 10-K/10-Q — foundry segment disclosure
}

export class SecEdgarSource implements NewsSource {
  readonly slug = "sec-edgar";
  readonly label = "SEC EDGAR";
  readonly assumeEntity = true;

  async fetch(opts: FetchNewsOptions = {}): Promise<RawNewsItem[]> {
    const data = await fetchJson(`https://data.sec.gov/submissions/CIK${CIK}.json`, {
      schema: Submissions,
      source: "sec-edgar",
      signal: opts.signal,
    });

    const r = data.filings.recent;
    const out: RawNewsItem[] = [];
    const n = Math.min(r.accessionNumber.length, 40); // newest first

    for (let i = 0; i < n; i++) {
      const form = r.form[i];
      if (!MATERIAL_FORMS.has(form)) continue;

      const filedAt = r.filingDate[i] ? new Date(`${r.filingDate[i]}T12:00:00Z`) : undefined;
      if (opts.since && filedAt && filedAt < opts.since) continue;

      const accession = r.accessionNumber[i];
      const accNoDashes = accession.replace(/-/g, "");
      const doc = r.primaryDocument[i];
      const url = `https://www.sec.gov/Archives/edgar/data/${CIK_NUM}/${accNoDashes}/${doc}`;
      const desc = r.primaryDocDescription?.[i];
      const items = r.items?.[i];

      const label = [form, desc && desc !== form ? desc : null, items ? `(items ${items})` : null]
        .filter(Boolean)
        .join(" ");

      out.push({
        externalId: accession,
        title: `Intel files ${label}`,
        url,
        summary: `Intel Corporation SEC filing — form ${form}${items ? `, items ${items}` : ""}.`,
        publishedAt: filedAt,
        sourceLabel: this.label,
        assumeEntity: true,
        forceRelevant: true,
        floorSeverity: itemFloor(form, items),
      });
    }

    return out;
  }
}
