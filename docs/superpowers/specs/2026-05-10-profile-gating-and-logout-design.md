# Profile-Gated Sections, Logout, and Manifest Gating — Design

## Problem

The configuration UI currently shows the global index/server sections and the manifest install panel before the user has done meaningful setup. Specifically:

1. The Global Status panel and Server Accordion render whenever the setup token is satisfied, even if no profile is created/unlocked.
2. There is no way for an unlocked user to "log out" and return to the unlock UI (e.g. to switch to a different recovery UID + passphrase).
3. The bottom Manifest panel appears the moment a profile is unlocked, even if no FTP server has been saved yet, which surfaces an unusable install link.

## Goals

- Hide the Global Status panel and Server Accordion until a profile is created or unlocked.
- Provide a "Log out" action in the top corner once the profile is ready. Clicking it returns the UI to the create/unlock state and hides the gated sections.
- Hide the bottom Manifest section until at least one FTP server has been saved. Show an inline note explaining the requirement when the manifest is hidden.

## Non-Goals

- Full credential teardown. Logout is "soft": it does not invalidate any backend state and does not clear the recovery UID. The user can immediately re-unlock the same profile or enter a different UID/passphrase.
- Any change to backend APIs.
- Any change to scan behavior or auto-restore on a fresh page load (auto-restore from a remembered passphrase still happens on initial mount; logout only affects the current session and prevents auto-restore on the next load by removing the stored passphrase).

## Changes

All changes are in three existing files. No new components.

### `src/web/App.tsx`

**Derived flag for "saved server":**
```ts
const hasSavedServer = useMemo(
  () => servers.some((s) => Boolean(s.host) && s.passwordConfigured),
  [servers],
);
```
- `host` non-empty + `passwordConfigured: true` is the signal the backend has accepted at least one server save (the password field is never echoed back, so `passwordConfigured` is the authoritative flag).

**Logout handler:**
```ts
function logout() {
  setProfileState("new");
  setProfileMessage("Enter your passphrase to unlock this browser profile.");
  setManifestUrl(null);
  setStremioInstallUrl(null);
  setPassphrase("");
  window.localStorage.removeItem(STORAGE_KEYS.passphrase);
  window.localStorage.removeItem(STORAGE_KEYS.manifestUrl);
  window.localStorage.removeItem(STORAGE_KEYS.stremioInstallUrl);
}
```
- Clears the in-memory passphrase so the unlock form is empty and the user can type a different passphrase.
- Removes the stored passphrase + manifest URLs so a page refresh after logout shows the unlock form rather than auto-restoring.
- Leaves `recoveryUid` populated (and stored) so the unlock form pre-fills with the current UID. The user can edit it to switch profiles.
- The auto-restore `useEffect` runs only on mount / `setupTokenRequired` change, so it will not re-fire and undo the logout in the same session.

**Render gating** (replacing lines 793-844 of `App.tsx`):
- `GlobalStatusPanel` and `ServerAccordion` only render when `profileReady` is true.
- The bottom install panel only renders when `profileReady && hasSavedServer`.
- When `profileReady && !hasSavedServer`, render a `Notice` in place of the install panel: *"Save at least one server's FTP settings to generate your manifest URL."*

The top install panel (visible when `!profileReady`) is unchanged.

### `src/web/components/Topbar.tsx`

- Add an optional prop `onLogout?: () => void`.
- When `profileReady` is true and `onLogout` is supplied, render a small "Log out" button next to the existing `StatusBadge` in the header. Use the existing `secondary-button` class (or the closest equivalent) for visual consistency.
- No structural changes to the brand lockup.

### `src/web/components/InstallPanel.tsx`

- No code changes. Component is simply not rendered until `hasSavedServer` is true.

## Data Flow

1. Setup token validated → `settingsUnlocked` true → `SetupTokenPanel` hidden, top `InstallPanel` (create/unlock form) shown.
2. User creates or unlocks profile → `profileReady` true → `GlobalStatusPanel` + `ServerAccordion` appear, top install panel hides, "Log out" button appears in topbar.
3. User saves first server FTP settings → `hasSavedServer` becomes true on next state update → bottom `InstallPanel` (manifest) appears, the placeholder note disappears.
4. User clicks "Log out" → state resets to step 1's "form visible" UI, gated sections collapse, recovery UID stays populated, passphrase field is empty.

## Testing

Manual verification in the browser:

- Fresh load with no remembered profile: only HeroPanel + create/unlock form visible. No global panel, no servers, no manifest, no logout button.
- Create a new profile: global panel + server accordion appear; manifest panel does NOT appear; placeholder note is shown; logout button appears in topbar.
- Save FTP settings on the first server: manifest panel appears; placeholder note disappears.
- Click "Log out": global + server + manifest sections disappear; create/unlock form reappears with recovery UID pre-filled and passphrase empty; logout button disappears.
- Refresh after logout: still on create/unlock form (auto-restore did not fire).
- Edit recovery UID and unlock with a different passphrase: profile loads as that other identity.
- Re-unlock with the same UID + passphrase: returns to fully unlocked state with prior server saved → manifest panel visible immediately.

No automated tests are added; this is presentation gating with no backend behavior change.

## Risks

- If `passwordConfigured` is ever returned as `true` for an in-memory unsaved form, the manifest panel could appear prematurely. Reviewed: `passwordConfigured` is only set via `serverFormFromPayload` / `serverFormFromLegacyPayload`, both of which are populated from backend responses. `emptyServerForm` defaults it to `false`. Safe.
- Removing `STORAGE_KEYS.manifestUrl` / `stremioInstallUrl` on logout means the next unlock issues a fresh `unlockProfile` round-trip rather than reading from local cache. This is intentional and acceptable.
