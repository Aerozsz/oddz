import { runMonitor } from "../lib/intc/monitor";

// Manual / local trigger for the INTC foundry monitor. Mirrors run-once.ts.
//   DATABASE_URL=… npm run intc:once
runMonitor()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
