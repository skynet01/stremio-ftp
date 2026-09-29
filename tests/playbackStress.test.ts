import { describe, expect, it } from "vitest";
import { defaultHarnessOptions, runPlaybackStress } from "../scripts/stress/playbackHarness";

// A reduced run of scripts/stress-playback.ts: the real app, basic-ftp and limiter against the in-process
// fake FTP server. Covers rapid seeking with aborts (B) and complete ranges for slow readers (C); the fault,
// start-up and HEAD-storm scenarios need longer runs and live in the script.
describe("playback stress (reduced)", () => {
  it("keeps bytes correct and leaks nothing while viewers seek, abort and read slowly", async () => {
    const report = await runPlaybackStress(
      defaultHarnessOptions({
        viewers: 3,
        scenarioMs: 700,
        scenarios: ["B", "C"],
        longPause: false,
        fileSizeBytes: 64 * 1024 * 1024,
        quiesceTimeoutMs: 5_000,
        poolIdleMs: 500,
        hangTimeoutMs: 10_000,
      }),
    );

    expect(report.violations).toEqual([]);
    expect(report.scenarios.map((scenario) => scenario.playbackFailures)).toEqual([0, 0]);
    expect(report.scenarios[0].outcomes["GET aborted"]).toBeGreaterThan(0);
    expect(report.scenarios[1].outcomes["GET complete"]).toBeGreaterThan(0);
  }, 20_000);
});
