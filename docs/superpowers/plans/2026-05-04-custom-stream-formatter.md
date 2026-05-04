# Custom Stream Formatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add profile-level custom stream name/description templates with a two-column formatter editor and preview, plus richer server accordion summaries.

**Architecture:** Persist formatter templates on `profiles`, expose them through existing customization APIs, and apply them in `streamResolver` with a small safe formatter engine. The UI edits these global templates under the global status panel, collapsed by default, and previews against a representative FTP stream.

**Tech Stack:** TypeScript, Express, SQLite via `better-sqlite3`, React, Vitest.

---

### Task 1: Formatter Engine

**Files:**
- Create: `src/server/stremio/streamFormatter.ts`
- Test: `tests/streamFormatter.test.ts`

- [ ] Write failing tests for variable substitution, `{tools.newLine}`, and `::bytes`.
- [ ] Implement a small formatter supporting `{addon.name}`, `{stream.serverName}`, `{stream.serverId}`, `{stream.filename}`, `{stream.path}`, `{stream.extension}`, `{stream.quality}`, `{stream.size}`, `{stream.size::bytes}`, `{stream.deliveryMode}`, and `{stream.mediaId}`.
- [ ] Ensure empty output falls back to defaults.

### Task 2: Persistence and API

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/profiles/profileService.ts`
- Modify: `src/server/profiles/profileRoutes.ts`
- Modify: `src/web/api.ts`
- Test: `tests/schema.test.ts`
- Test: `tests/profileRoutes.test.ts`

- [ ] Add nullable `stream_name_template` and `stream_description_template` columns to `profiles`.
- [ ] Include formatter fields in `AddonCustomization`.
- [ ] Validate formatter strings with a bounded length.
- [ ] Persist and load formatter templates through customization endpoints and server load endpoints.

### Task 3: Stremio Output

**Files:**
- Modify: `src/server/stremio/streamResolver.ts`
- Modify: `src/server/stremio/routes.ts`
- Test: `tests/stremioRoutes.test.ts`

- [ ] Pass formatter templates into stream resolution.
- [ ] Apply templates to stream `name` and `description`.
- [ ] Preserve direct/proxy URL behavior.

### Task 4: UI Editor and Accordion Summary

**Files:**
- Create: `src/web/components/StreamFormatterPanel.tsx`
- Modify: `src/web/components/GlobalStatusPanel.tsx`
- Modify: `src/web/components/ServerAccordion.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/webApp.test.tsx`

- [ ] Add collapsed formatter settings under the global status block.
- [ ] Use a two-column layout: textareas on the left, live preview on the right.
- [ ] Save formatter templates through the global customization save path.
- [ ] Add total items and scan time/progress to each server accordion trigger.
- [ ] Make server names in accordion triggers larger and green.

### Task 5: Verification

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Commit, push, deploy, and verify the live health endpoint.
