import { runGeoMonitor } from "../lib/geo/monitor";

// Manual / local trigger for the geopolitics monitor.
//   DATABASE_URL=… npm run geo:once
runGeoMonitor()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
