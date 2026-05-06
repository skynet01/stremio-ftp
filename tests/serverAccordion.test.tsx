/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServerAccordion, type ServerForm } from "../src/web/components/ServerAccordion";

const failedServer: ServerForm = {
  id: 12,
  name: "Challenger",
  host: "ftp.example.test",
  port: "21",
  username: "user",
  password: "",
  passwordConfigured: true,
  tlsMode: "explicit",
  allowInvalidCertificate: false,
  rootPaths: "/",
  catalogEnabled: true,
  catalogContentTypes: { movies: true, series: true, anime: false },
  libraryLayout: "auto",
  streamDeliveryMode: "proxy",
  indexStatus: { lastScanAt: "2026-05-04T16:00:30.530Z", mediaItems: 549 },
  scanStatus: {
    id: 51,
    status: "failed",
    trigger: "scheduled",
    progressPercent: 75,
    entriesSeen: 0,
    filesSeen: 436,
    directoriesSeen: 0,
    currentPath: "/Blockbuster Movies/The Stewardesses (1969)",
    estimatedSecondsRemaining: null,
    message: "Scan failed: Server sent FIN packet unexpectedly, closing connection. Requeued to rescan in 5m.",
    error: "Server sent FIN packet unexpectedly, closing connection.",
    queuedAt: "2026-05-04T21:55:40.653Z",
    startedAt: "2026-05-04T21:55:40.654Z",
    finishedAt: "2026-05-04T21:57:15.861Z",
    mediaItems: 549,
  },
  scanSchedule: { intervalMinutes: 0, nextScheduledScanAt: null },
  connectionStatus: { lastTestedAt: null, ok: null },
  pendingScanAfter: "2026-05-04T22:02:15.861Z",
  message: "Scan failed: Server sent FIN packet unexpectedly, closing connection. Retry scheduled.",
};

describe("ServerAccordion", () => {
  it("shows failed scan retry reason in the collapsed server row", () => {
    render(
      <ServerAccordion
        servers={[failedServer]}
        expandedServerId={null}
        profileReady={true}
        onToggle={vi.fn()}
        onAddServer={vi.fn()}
        onDeleteServer={vi.fn()}
        onServerChange={vi.fn()}
        onSaveServer={vi.fn()}
        onTestServer={vi.fn()}
        onRefreshServer={vi.fn()}
        onCancelServer={vi.fn()}
        onUpdateScanSchedule={vi.fn()}
      />,
    );

    expect(screen.getByText("Retry pending")).toBeTruthy();
    expect(screen.getByText(/Server sent FIN packet unexpectedly, closing connection/)).toBeTruthy();
  });

  it("clears uncategorized when Stremio catalogs are turned off", () => {
    const onServerChange = vi.fn();
    render(
      <ServerAccordion
        servers={[{ ...failedServer, catalogContentTypes: { ...failedServer.catalogContentTypes, uncategorized: true } }]}
        expandedServerId={failedServer.id}
        profileReady={true}
        onToggle={vi.fn()}
        onAddServer={vi.fn()}
        onDeleteServer={vi.fn()}
        onServerChange={onServerChange}
        onSaveServer={vi.fn()}
        onTestServer={vi.fn()}
        onRefreshServer={vi.fn()}
        onCancelServer={vi.fn()}
        onUpdateScanSchedule={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Show catalogs in Stremio")).toBeChecked();
    expect(screen.getByLabelText("Show uncategorized")).toBeChecked();

    fireEvent.click(screen.getByLabelText("Show catalogs in Stremio"));

    expect(onServerChange).toHaveBeenCalledWith(failedServer.id, {
      catalogEnabled: false,
      catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: false },
    });
  });
});
