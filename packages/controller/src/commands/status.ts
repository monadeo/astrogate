import type { Paths } from "../paths.js";
import { StateDb } from "../state/db.js";

export function status(paths: Paths): void {
  const db = new StateDb(paths.stateDb);
  const running = db.runningAttempts();
  if (running.length === 0) console.log("No running sessions.");
  for (const row of running) {
    console.log(`${row.role.padEnd(8)} ${row.repo}#${row.ticket} attempt ${row.attempt} pane ${row.paneId}${row.pr ? ` PR #${row.pr}` : ""}`);
  }
  db.close();
}
