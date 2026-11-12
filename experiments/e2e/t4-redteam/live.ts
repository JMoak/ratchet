/**
 * The live phases of the T4 track. The injection study was dropped from this track by the
 * coordinator; what remains live is the arithmetic and date weak-spot run.
 */
import { runArith } from "./arith.ts";

export async function runLive(): Promise<void> {
  await runArith();
}
