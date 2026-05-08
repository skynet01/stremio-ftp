/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GlobalStatusPanel } from "../src/web/components/GlobalStatusPanel";

const baseStats = {
  totalItems: 10,
  movies: 8,
  series: 1,
  anime: 0,
  uncategorized: 1,
  servers: 2,
  activeScans: 0,
  pendingScans: 0,
  lastCompletedScanAt: "2026-05-04T07:28:50.793Z",
  status: "ready" as const,
};

describe("GlobalStatusPanel", () => {
  it("pulses stat values when they update", async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <GlobalStatusPanel stats={baseStats} scanProgress={null} profileReady={true} scanActive={false} onRescanAll={() => undefined} />,
    );

    expect(screen.getByText("10")).toHaveClass("stat-value");
    expect(screen.getByText("10")).not.toHaveClass("stat-value-pulse");

    rerender(
      <GlobalStatusPanel
        stats={{ ...baseStats, totalItems: 11 }}
        scanProgress={null}
        profileReady={true}
        scanActive={false}
        onRescanAll={() => undefined}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.getByText("11")).toHaveClass("stat-value-pulse");
    vi.useRealTimers();
  });

  it("stacks the global index header controls on mobile", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.global-status-panel\s+\.panel-header\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.global-status-state\s*{[^}]*width:\s*100%;[^}]*justify-content:\s*space-between;/);
  });
});
