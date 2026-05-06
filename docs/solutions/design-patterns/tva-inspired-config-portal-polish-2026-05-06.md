---
title: TVA-Inspired Configuration Portal Polish
date: 2026-05-06
category: design-patterns
module: stremio-ftp configuration portal
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "Polishing a React/Vite configuration portal after design review"
  - "Sequencing setup-first flows before dashboard controls are available"
  - "Improving accessibility semantics for accordion and menu interactions"
  - "Refining UI motion, checkbox styling, and dense changelog presentation"
related_components:
  - src/web/App.tsx
  - src/web/styles.css
  - src/web/components/ChangelogDrawer.tsx
  - src/web/components/GlobalStatusPanel.tsx
  - src/web/components/ServerAccordion.tsx
  - src/web/components/IndexStatusPanel.tsx
tags:
  - react
  - vite
  - configuration-portal
  - tva-inspired-ui
  - accessibility
  - changelog
  - motion
  - impeccable
---

# TVA-Inspired Configuration Portal Polish

## Context

The stremio-ftp React/Vite configuration portal was already functional, but an Impeccable review found design and implementation issues that would make the UI feel less trustworthy over time: setup controls competed with dashboard controls, accordion and dropdown semantics were incomplete, progress bars animated `width`, default checkbox styling broke the TVA-inspired visual language, and the changelog drawer was harder to scan than it needed to be.

The fix in commit `afd8b0c` treated the pass as a product interaction cleanup, not only a visual restyle. The portal kept its dense admin-tool structure while leaning further into a restrained TVA/Loki computer interface: warm dark surfaces, phosphor green accents, subtle scanline motion, custom form controls, and compact status affordances.

This polish built on earlier portal work: setup-token gating, the changelog drawer, Library Settings layout, global scan progress, and multi-server status panels had already been iterated. Prior changelog work also showed why bundled changelog metadata plus optional GitHub refresh is safer than build-time `git log` in Docker, where `.git` may be unavailable.

## Guidance

Use design-review cleanup to tighten behavior, accessibility, scanability, and motion together. A strong polish pass should encode the intended interaction model in state order, component semantics, CSS motion strategy, and tests.

For setup-heavy configuration portals, keep first-run setup ahead of operational controls until the setup state is ready:

```tsx
const installPanel = showSetupTokenMessage ? null : (
  <InstallPanel profileReady={profileReady} {...installProps} />
);

return (
  <div className="portal-stack">
    {!profileReady ? installPanel : null}
    <GlobalStatusPanel profileReady={profileReady} />
    <ServerAccordion profileReady={profileReady} />
    {profileReady ? installPanel : null}
  </div>
);
```

This makes readiness visible in the page structure. Users see the profile task before dashboard and server controls imply the system is ready.

For disclosure surfaces, make the accessibility tree match the intended control, but avoid noisy landmarks. Use `role="region"` only when the expanded body is substantial enough to deserve a named region. If `aria-controls` matters to your testing or assistive-tech contract, prefer keeping the panel mounted and toggling `hidden`; if you unmount collapsed panels, understand that the collapsed trigger temporarily references an element that is not in the DOM.

```tsx
<button
  type="button"
  id={triggerId}
  aria-expanded={expanded}
  aria-controls={bodyId}
  onClick={() => onToggle(server.id)}
>
  <ChevronRight aria-hidden={true} />
</button>

<div id={bodyId} role="region" aria-labelledby={triggerId} hidden={!expanded}>
  ...
</div>
```

For command dropdowns, use real menu semantics only when implementing the menu interaction model: focus handling, Escape close behavior, and arrow-key navigation for multi-item menus. For a simple popover with ordinary buttons, keep button/list semantics instead of adding ARIA menu roles.

```tsx
<button
  type="button"
  aria-haspopup="menu"
  aria-expanded={menuOpen}
  aria-controls="global-rescan-menu"
>
  <ChevronDown aria-hidden="true" />
</button>

<div id="global-rescan-menu" role="menu">
  <button type="button" role="menuitem">Force reindex all</button>
</div>
```

Tests should query the same roles users receive and cover keyboard behavior when menu semantics are used. After `role="menuitem"` was added, the web test changed from `findByRole("button", { name: "Force reindex all" })` to `findByRole("menuitem", { name: "Force reindex all" })`.

For frequently changing indicators, keep the animation but move it off layout properties. The progress bar should have a stable track and a transform-driven fill:

```tsx
const boundedProgress = Math.max(0, Math.min(100, progressPercent));

<div
  className="scan-progress"
  role="progressbar"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={boundedProgress}
>
  <span style={{ transform: `scaleX(${boundedProgress / 100})` }} />
</div>
```

```css
.scan-progress span {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
```

For custom checkboxes, keep the native input and label relationship, then style the checked and unchecked states. In this portal, the unchecked state uses a muted dark panel fill and green border instead of browser-white defaults, while the checked state reveals a phosphor square through `::before`.

For high-density history surfaces, make the structure explicit. The changelog drawer became easier to scan by limiting visible entries to 15, using a date column instead of commit hashes as the first column, keeping the header sticky while scrolling, and color-coding `feat` and `fix` tags.

## Why This Matters

Product UI polish fails when it only adjusts colors, shadows, or spacing. This pass worked because the visual direction and the interaction model moved together. The durable checklist is:

- First-run users see setup before controls that depend on setup.
- Screen reader and keyboard users get accurate disclosure and menu semantics.
- Tests assert against the intended accessibility tree instead of incidental DOM structure.
- Progress animation remains visible but avoids layout work.
- Checkbox states match the visual language without losing native form behavior.
- The changelog drawer supports quick scanning instead of becoming an undifferentiated list.

The Impeccable scan initially flagged a layout-property animation and an Inter usage in the menu. The useful lesson was not that every familiar font or animation is wrong. The lesson was to make each choice intentional: use the portal's established type system, animate transform/opacity rather than layout properties, and let the TVA-inspired treatment serve task clarity rather than decoration.

## When to Apply

- A configuration portal, admin tool, or dashboard is functional but feels generic or slightly brittle.
- Setup, unlock, install, or onboarding tasks appear beside controls that only work after setup.
- Accordions, drawers, dropdowns, or menus are visually present but semantically weak.
- Tests rely on generic roles or incidental markup after the component has gained stronger accessibility semantics.
- Animated elements change layout properties such as `width`, `height`, `top`, or `left`.
- A changelog, history, audit log, or activity drawer needs better scanability.

## Examples

Before, profile setup and dashboard controls shared the same broad experience, which made the interface feel available before the profile was ready. After, `InstallPanel` renders before the dashboard until `profileReady`; once the profile is ready, the manifest install panel moves to the end where it fits the completed workflow.

Before, server accordion triggers had visual expand/collapse behavior but did not expose `aria-expanded` and `aria-controls`. After, each trigger controls a labeled region, and the chevron rotation is driven from `aria-expanded`.

Before, scan progress used `transition: width`. After, the fill element keeps `width: 100%` and animates `transform: scaleX(...)`.

Before, checkboxes in the dark TVA interface used browser-white unchecked boxes. After, unchecked, hover, checked, and disabled states all use the same dark panel, green phosphor, and muted border vocabulary.

Before, the changelog drawer led with hashes and a longer list. After, it shows the last 15 entries, leads with the date, keeps the header sticky, and gives `feat` and `fix` distinct colors.

## Related

- [Original portal design spec](../../superpowers/specs/2026-05-02-stremio-ftp-addon-design.md)
- [Original portal implementation plan](../../superpowers/plans/2026-05-02-stremio-ftp-addon.md)
- [Background scanning progress plan](../../superpowers/plans/2026-05-03-background-scanning.md)
- [Multi-server manifest design](../../superpowers/specs/2026-05-04-multi-ftp-server-manifest-design.md)
- [Multi-server manifest implementation plan](../../superpowers/plans/2026-05-04-multi-ftp-server-manifest.md)
- [Custom stream formatter plan](../../superpowers/plans/2026-05-04-custom-stream-formatter.md)
