import type { Request } from "express";

export function countryCodeFromRequest(req: Request): string | null {
  const value = firstHeaderValue(req.headers["cf-ipcountry"])?.trim().toUpperCase();
  if (!value || value === "XX" || !/^[A-Z]{2}$/.test(value)) return null;
  return value;
}

function firstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}
