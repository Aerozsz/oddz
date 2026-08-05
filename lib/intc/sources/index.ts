import { GoogleNewsSource } from "./google-news";
import { IntelNewsroomSource } from "./intel-newsroom";
import { SecEdgarSource } from "./sec-edgar";
import type { NewsSource } from "../types";

/**
 * The source registry. Each adapter is independent and time-budgeted by the
 * monitor, so a degraded feed can only truncate its own coverage — never the
 * run. Add a source here and the monitor picks it up.
 */
export const newsSources: NewsSource[] = [
  new GoogleNewsSource(),
  new SecEdgarSource(),
  new IntelNewsroomSource(),
];

export { GoogleNewsSource, SecEdgarSource, IntelNewsroomSource };
