import { describe, expect, it } from "vitest";
import { installPauseGuards } from "../examples/arcade/common.js";

function playback() {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  let running = true;
  const pauses = [];
  installPauseGuards(
    document,
    window,
    () => running,
    (reason) => {
      running = false;
      pauses.push(reason);
    },
  );
  return { document, window, pauses, isRunning: () => running };
}

describe("arcade interruption boundary", () => {
  it("pauses once when hidden and never resumes when visibility returns", () => {
    const run = playback();
    run.document.hidden = true;
    run.document.dispatchEvent(new Event("visibilitychange"));
    expect(run.isRunning()).toBe(false);
    expect(run.pauses).toHaveLength(1);
    run.document.hidden = false;
    run.document.dispatchEvent(new Event("visibilitychange"));
    run.document.hidden = true;
    run.document.dispatchEvent(new Event("visibilitychange"));
    expect(run.isRunning()).toBe(false);
    expect(run.pauses).toHaveLength(1);
  });

  it("Escape interrupts active play but respects an already handled dialog event", () => {
    const run = playback();
    const handled = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    handled.preventDefault();
    run.document.dispatchEvent(handled);
    expect(run.isRunning()).toBe(true);
    const escapeKey = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    run.document.dispatchEvent(escapeKey);
    expect(escapeKey.defaultPrevented).toBe(true);
    expect(run.isRunning()).toBe(false);
    expect(run.pauses).toHaveLength(1);
  });

  it("page exit stops active play and unrelated keys do not", () => {
    const run = playback();
    run.document.dispatchEvent(Object.assign(new Event("keydown"), { key: " " }));
    expect(run.isRunning()).toBe(true);
    run.window.dispatchEvent(new Event("pagehide"));
    expect(run.isRunning()).toBe(false);
    expect(run.pauses).toHaveLength(1);
  });
});
