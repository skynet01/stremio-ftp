# Watch your 3DFlick library in Stremio

An alternative to mounting our FTP with rclone. Instead, install our Stremio addon, point it at your account, and stream your library from any Stremio client.

There are two paths below. **Part 1** is the quick setup you'll use 99% of the time. **Part 2** is the advanced option for power users.

---

## Part 1 — Quick setup (for 3DFlick subscribers)

You don't need to fill anything in by hand. We hand you a pre-filled settings file with your account and the 3DFlick servers already configured.

### 1. Download your settings file

Sign in to 3dflickfix.net and grab your `stremio-ftp-settings.json` from the account page.

### 2. Open the configure page

<https://ftpstrem.skynetsource.com/configure>

Paste the **setup token** we provided (or open the one-shot link from your account page — the token is stripped from the URL automatically).

### 3. Import your settings

On the unlock screen, click **Import settings** (left of the Create profile button) and pick the JSON file. You'll see `N servers loaded`.

### 4. Create your profile

Type a passphrase (8+ chars, used to encrypt your credentials — there's no password recovery, so remember it). Click **Create profile**.

### 5. Install in Stremio

Scroll to the bottom — the manifest panel appears with two buttons:
- **Install in Stremio** — opens your Stremio client and adds the addon.
- **Copy manifest URL** — paste into any other Stremio client.

That's it. The 3DFlick catalog shows up in Stremio's Discover; individual titles play directly from FTP.

> **Important — official Stremio clients only.** The public instance hands out raw `ftp://` stream URLs and the official Stremio apps are the only clients we've confirmed will open them. Third-party Stremio forks may or may not work; if you need broader client compatibility, see [Part 2](#part-2--advanced-self-host-with-proxy).

### Per-platform cheat sheet

| Platform | Stremio client | Player |
|---|---|---|
| **Windows / macOS / Linux** | [Stremio Desktop](https://www.stremio.com/) | Built-in — no extra setup, plays FTP natively. |
| **Web** (any OS) | [Stremio Web](https://web.strem.io/) | Built-in browser player; falls back to your OS's external player for FTP. |
| **Android (phone / tablet)** | [Stremio for Android](https://www.stremio.com/) | Built-in. For 3D, set Settings → Player → *Always start in external player* and pair with a 3D-capable Android player. |
| **Meta Quest 3 / 2 / Pro** | [Stremio VR (Horizon Store)](https://www.meta.com/experiences/stremio/24009388261996890/) **or** [Stremio Web](https://web.strem.io/) in the Quest browser | For 3D, enable Stremio's external-player handoff and use **[4XVR](https://www.meta.com/experiences/4xvr-video-player/5936567899722707/)** or **[Skybox](https://www.meta.com/experiences/skybox-vr-video-player/2063931653705427/)**. |
| **Apple Vision Pro** | [Stremio Web](https://web.strem.io/) in Safari (no native Stremio app yet) | Hand off to **[Moon Player](https://apps.apple.com/us/app/moon-player-ai-enhanced-3d/id6475702609)** or **[CineUltra](https://apps.apple.com/us/app/cineultra-immersive-cinema/id6478853637)** for real 3D / spatial playback. Walkthrough: [Stremio on Vision Pro via Moon](https://moonvrplayer.com/blog/178/how-to-watch-stremio-on-apple-vision-pro). |
| **iPhone / iPad** | [Stremio Lite](https://blog.stremio.com/stremio-lite-released-to-apple-app-store/) or [Stremio Web in Safari](https://blog.stremio.com/using-stremio-web-on-iphone-ipad/) | Falls back to the system external player. |
| **Apple TV** | [Stremio Lite for tvOS](https://blog.stremio.com/stremio-lite-for-apple-tv-tvos-is-now-in-app-store/) | Built-in. |

If 3D playback isn't picking up automatically in your external player, set the stereo mode manually (Half SBS for most 1080p rips, Full SBS for 4K).

### Day-to-day notes

- **Coming back to the configure page** — same browser, it auto-loads. Different browser/device: enter your **recovery UID** (visible top-right of the configure page) and passphrase, click **Unlock profile**.
- **Update credentials** — open the configure page, expand the server, change the field, click **Save FTP settings**.
- **Delete your profile** — trash icon next to the status badge, confirmation required.
- **Log out** — top right. Clears this browser only; the profile stays.

---

## Part 2 — Advanced (self-host with proxy)

Self-hosting the addon unlocks features the public instance can't offer:

- **Proxy streaming** — Stremio receives an `https://` URL from your instance instead of `ftp://`, so any Stremio-compatible client works (not just the official ones). Useful for the iOS Stremio Lite, third-party clients, and clients with picky URL handling.
- **No public-instance limits** — bump or remove the per-profile server cap, run multiple profiles, ship custom catalogs.
- **Privacy** — your FTP credentials never leave your hardware.
- **Bandwidth** — your server's pipe, not ours.

Run it yourself in Docker. Full setup, environment variables, and a sample Compose file are in the README:

**Repo:** <https://github.com/skynet01/stremio-ftp>

The settings JSON you exported on the public instance imports cleanly into a self-hosted instance, so you don't need to redo anything.

### Third-party Stremio-compatible clients (work with self-hosted proxy mode)

Once you're running proxy mode, you have a much bigger client pool. A few worth knowing about:

- **Fusion Media Center** (iOS / iPadOS / Apple TV) — Stremio-compatible, free, supports debrid. Walkthrough: <https://troypoint.com/fusion-media-center/>
- **Nuvio** — open-source Stremio addon + mobile client (iOS / Android). Repos: <https://github.com/tapframe/NuvioStreamsAddon> and <https://github.com/tapframe/NuvioMobile>
- **Strexo** (Android TV) — Stremio external-player wrapper with progress sync and Trakt integration: <https://strexo.space/>

---

## Troubleshooting in 30 seconds

- **Stream won't play** — your client probably can't open `ftp://`. Switch to Stremio Desktop, or set up an external player (see the per-platform table).
- **"Draft" badge on a server** — host saved, credentials missing. Click the server, fill them in, **Save FTP settings**.
- **Forgot passphrase** — no recovery. Delete the profile (trash icon) and create a new one with your JSON.
- **Scan never finishes / "FIN packet" error** — your FTP host dropped the connection. The addon retries automatically; check back in a few minutes.

Use only with media you own or are licensed to access.
