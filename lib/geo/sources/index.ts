import { GoogleNewsGeoSource } from "./google-news";
import { TruthSocialSource } from "./truth-social";
import type { GeoSource } from "../types";

/** Source registry — each is time-budgeted + isolated by the monitor. */
export const geoSources: GeoSource[] = [
  new GoogleNewsGeoSource(),
  new TruthSocialSource(),
];

export { GoogleNewsGeoSource, TruthSocialSource };
