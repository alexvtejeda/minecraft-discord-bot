// Run as a real process by signals.test.ts: prepare's handler is swapped for run's, like runHosted does.
// With "unhooked", every handler is removed again, so the signal should end the process as usual.
import { onStopSignal } from "../../src/host/signals";

const unhookPrepare = onStopSignal(() => console.log("prepare handler"));
const unhookRun = onStopSignal(() => {
  console.log("run handler");
  process.exit(0);
});
unhookPrepare();
if (process.argv[2] === "unhooked") unhookRun();
console.log("ready");
setInterval(() => {}, 1000);
