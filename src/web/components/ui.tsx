import { createElement as h, type ReactNode } from "react";
import type { ConnectionStatus, ScanStatus } from "../api.js";

export type StatusTone = "green" | "amber" | "red" | "gray";

export function StatusBadge({ tone, children }: { tone: StatusTone; children?: ReactNode }) {
  return h("span", { className: `badge badge-${tone}` }, children);
}

export function field(label: string, id: string, control: ReactNode, className = "field-stack") {
  return h("div", { className }, h("label", { htmlFor: id }, label), control);
}

export function Notice({ children, className = "" }: { children?: ReactNode; className?: string }) {
  const warning = noticeText(children).match(/\b(error|unable|failed|invalid|required|missing|too many|cooldown|not configured)\b/i);
  return h("p", { className: `notice notification ${warning ? "notification-warning" : ""} ${className}`.trim(), role: "status" }, children);
}

function noticeText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(noticeText).join(" ");
  return "";
}

export function formatScanTime(lastScanAt: string | null) {
  if (!lastScanAt) return "Never";
  const date = new Date(lastScanAt);
  if (Number.isNaN(date.getTime())) return lastScanAt;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatConnectionStatus(status: ConnectionStatus) {
  if (!status.lastTestedAt) return "Untested";
  return `${status.ok ? "Passed" : "Failed"} ${formatScanTime(status.lastTestedAt)}`;
}

export function formatNextScan(nextScheduledScanAt: string | null) {
  if (!nextScheduledScanAt) return "Not scheduled";
  const date = new Date(nextScheduledScanAt);
  if (Number.isNaN(date.getTime())) return nextScheduledScanAt;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "Due now";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return formatScanTime(nextScheduledScanAt);
}

export function formatEta(seconds: number | null) {
  if (seconds === null) return "Scanning";
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.ceil(seconds / 60)}m left`;
}

export function scanIsActive(status: ScanStatus) {
  return status.status === "queued" || status.status === "running";
}

export function filledClass(value: string | number | boolean | null | undefined, extra = "") {
  const filled = typeof value === "boolean" ? value : String(value ?? "").trim().length > 0;
  return [extra, filled ? "filled-control" : ""].filter(Boolean).join(" ");
}
