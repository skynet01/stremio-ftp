/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
    mediaItemsAdded: 0,
    scanMode: "incremental",
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

    const catalogsGroup = screen.getByRole("group", { name: "Catalogs" });
    const contentCatalogsToggle = within(catalogsGroup).getByLabelText("Show content catalogs");
    const uncategorizedCatalogsToggle = within(catalogsGroup).getByLabelText("Show Uncategorized catalogs");

    expect(contentCatalogsToggle).toBeChecked();
    expect(uncategorizedCatalogsToggle).toBeChecked();
    expect(contentCatalogsToggle.closest("label")?.classList.contains("catalog-toggle")).toBe(false);
    expect(
      Boolean(
        contentCatalogsToggle.compareDocumentPosition(uncategorizedCatalogsToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    fireEvent.click(contentCatalogsToggle);

    expect(onServerChange).toHaveBeenCalledWith(failedServer.id, {
      catalogEnabled: false,
      catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: false },
    });
  });

  it("shows whether a server is running a full scan or difference update", () => {
    render(
      <ServerAccordion
        servers={[
          {
            ...failedServer,
            scanStatus: {
              ...failedServer.scanStatus,
              status: "running",
              progressPercent: 42,
              message: "Scanning FTP library.",
              error: null,
              scanMode: "incremental",
            },
            pendingScanAfter: null,
          },
        ]}
        expandedServerId={failedServer.id}
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

    expect(screen.getByText("Difference update")).toBeTruthy();
    expect(screen.getByText(/42% difference update/)).toBeTruthy();
  });

  it("groups library selects and server content separately from catalog toggles", () => {
    render(
      <ServerAccordion
        servers={[failedServer]}
        expandedServerId={failedServer.id}
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

    const libraryLayout = screen.getByLabelText("Library layout");
    const streamDelivery = screen.getByLabelText("Stream delivery");
    const selectRow = libraryLayout.closest(".library-select-row");
    const serverContent = screen.getByRole("group", { name: "Server content types" });
    const catalogsGroup = screen.getByRole("group", { name: "Catalogs" });
    const catalogHeading = screen.getByRole("heading", { name: "Catalogs" });

    expect(selectRow).toBeTruthy();
    expect(streamDelivery.closest(".library-select-row")).toBe(selectRow);
    expect(selectRow?.querySelectorAll(".field-stack")).toHaveLength(2);
    expect(serverContent.closest(".library-select-column")).toBeTruthy();
    expect(catalogHeading.closest(".library-settings-header")).toBeTruthy();
    expect(catalogHeading.closest(".catalog-options-column")).toBeNull();
    expect(within(serverContent).getByLabelText("Movies")).toBeTruthy();
    expect(within(serverContent).getByLabelText("Series")).toBeTruthy();
    expect(within(serverContent).getByLabelText("Anime")).toBeTruthy();
    expect(within(catalogsGroup).queryByLabelText("Movies")).toBeNull();
    expect(within(catalogsGroup).queryByLabelText("Series")).toBeNull();
    expect(within(catalogsGroup).queryByLabelText("Anime")).toBeNull();
  });

  it("confirms before deleting a server", () => {
    const onDeleteServer = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm");
    confirmSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(
      <ServerAccordion
        servers={[failedServer, { ...failedServer, id: 13, name: "Endeavour" }]}
        expandedServerId={failedServer.id}
        profileReady={true}
        onToggle={vi.fn()}
        onAddServer={vi.fn()}
        onDeleteServer={onDeleteServer}
        onServerChange={vi.fn()}
        onSaveServer={vi.fn()}
        onTestServer={vi.fn()}
        onRefreshServer={vi.fn()}
        onCancelServer={vi.fn()}
        onUpdateScanSchedule={vi.fn()}
      />,
    );

    const deleteButton = screen.getByRole("button", { name: "Delete server" });
    fireEvent.click(deleteButton);
    expect(onDeleteServer).not.toHaveBeenCalled();

    fireEvent.click(deleteButton);
    expect(onDeleteServer).toHaveBeenCalledWith(failedServer.id);
  });

  it("keeps primary server actions in one mobile row", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.server-button-row\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*44px\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\);/);
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.server-button-row\s+\.save-server-button\s*{[^}]*grid-column:\s*1\s*\/\s*-1;/);
  });

  it("keeps library columns aligned with server details in the stylesheet", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/\.library-settings-grid\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*65fr\)\s*minmax\(300px,\s*35fr\);/s);
    expect(css).toMatch(/\.library-settings-header\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*65fr\)\s*minmax\(300px,\s*35fr\);/s);
    expect(css).toMatch(/\.server-detail-grid\s*{[^}]*padding-inline:\s*clamp\(22px,\s*3vw,\s*30px\);/s);
    expect(css).toMatch(/\.catalog-options-column\s+\.toggle-row\s*{[^}]*margin-top:\s*0;/s);
  });

  it("keeps the mobile server badge inline with the trigger title row", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.server-accordion-trigger\s*{[^}]*grid-template-columns:\s*24px\s+minmax\(0,\s*1fr\)\s+auto;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.server-accordion-trigger\s+\.badge\s*{[^}]*grid-column:\s*3;/);
  });
});
