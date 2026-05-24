# Handoff: Shared Index Schedule Sync and Stream Status

Date: 2026-05-24
Branch: `admin-dashboard`

## Summary

This change makes shared index scanning behave like a synchronized fleet instead of independent per-server timers.

- New shared index groups default to a 12 hour scan interval.
- Admin schedule selector labels the 12 hour interval as "Twice a day".
- Shared index scheduled scans align to interval boundaries.
- When any shared index group is due for a scheduled scan, all enabled scheduled shared index groups are queued together.
- Pending retry scans are still handled per server/group, so a transient failure retry does not fan out to every shared index group.
- Normal non-shared profile/server schedules keep the previous `now + interval` behavior.

The change also adds admin visibility into active proxy playback:

- `ProxyStreamTracker` tracks in-memory active proxy GET streams.
- `/api/admin/streams` returns active streams and summary counts.
- Admin dashboard shows a "Running streams" stat and a compact active stream list when streams are open.

## Key Files

- `src/server/scanner/schedule.ts`
- `src/server/scanner/scanQueue.ts`
- `src/server/profiles/profileService.ts`
- `src/server/proxy/streamTracker.ts`
- `src/server/proxy/proxyRoutes.ts`
- `src/server/proxy/ftpProxyResolver.ts`
- `src/server/admin/adminRoutes.ts`
- `src/web/components/AdminDashboard.tsx`
- `src/web/api.ts`

## Verification

Passed locally:

```bash
npx vitest run --exclude '.worktrees/**'
npm run typecheck
npm run build
```

Note: plain `npm test` also discovers the checked-in `.worktrees/iso-feature` copy, which contains stale tests and should be excluded for current-branch verification.

## Deployment Status

Not deployed to Oracle yet. To ship it there, create a bundle from this branch and apply/rebuild on the Oracle server.
