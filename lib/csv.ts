export function toCsv(rows: (string | number | undefined | null)[][]): string {
  const esc = (v: string | number | undefined | null) => {
    const s = v === undefined || v === null ? "" : String(v);
    // Neutralise spreadsheet formula injection from student-typed text.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  // BOM so Excel opens UTF-8 correctly.
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}
