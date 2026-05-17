import { Router, type Request } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { countryCodeFromRequest } from "../http/requestMetadata.js";
import type { ScanQueue } from "../scanner/scanQueue.js";
import { ProfileNotFoundError, ProfileService } from "../profiles/profileService.js";

const adminAuthSchema = z.object({
  browserUid: z.string().min(8),
  passphrase: z.string().min(8),
});
const setAdminSchema = adminAuthSchema.extend({
  adminEnabled: z.boolean(),
});
const profileIdSchema = z.coerce.number().int().positive();

function urls(baseUrl: string, token: string) {
  const manifestUrl = `${baseUrl}/u/${token}/manifest.json`;
  return {
    manifestUrl,
    stremioInstallUrl: manifestUrl.replace(/^https?:\/\//, "stremio://"),
  };
}

export function adminRoutes(config: AppConfig, service: ProfileService, scanQueue: ScanQueue) {
  const router = Router();

  async function authorize(req: Request) {
    const parsed = adminAuthSchema.safeParse(req.body);
    if (!parsed.success) return { ok: false as const, status: 400, error: "Invalid admin request" };
    let unlocked: { profileId: number };
    try {
      unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase, countryCodeFromRequest(req));
    } catch {
      return { ok: false as const, status: 401, error: "Invalid passphrase" };
    }
    if (!service.isAdminBrowserUid(parsed.data.browserUid, config.adminBrowserUids)) {
      return { ok: false as const, status: 403, error: "Admin access required" };
    }
    return { ok: true as const, profileId: unlocked.profileId, browserUid: parsed.data.browserUid };
  }

  router.post("/profiles", async (req, res) => {
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const list = service.listAdminProfileSummaries(config.adminBrowserUids);
    const profiles = list.profiles.map((profile) => {
      const scanStatus = scanQueue.getProfileScanStatus(profile.id);
      const activeScans = scanStatus.status === "running" ? 1 : 0;
      const queuedScans = scanStatus.status === "queued" ? 1 : 0;
      return {
        ...profile,
        activeScans,
        pendingScans: profile.pendingScans + queuedScans,
        manifestUrl: null,
        stremioInstallUrl: null,
      };
    });

    res.json({
      summary: {
        ...list.summary,
        activeScans: profiles.reduce((sum, profile) => sum + profile.activeScans, 0),
        pendingScans: profiles.reduce((sum, profile) => sum + profile.pendingScans, 0),
      },
      profiles,
    });
  });

  router.post("/profiles/:profileId/manifest-token", async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile id" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const issued = service.issueInstallToken(profileId.data);
      res.json({ profileId: profileId.data, ...urls(config.baseUrl, issued.installUrlToken) });
    } catch (error) {
      if (error instanceof ProfileNotFoundError) return res.status(404).json({ error: "Profile not found" });
      throw error;
    }
  });

  router.post("/profiles/:profileId/delete", async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile id" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const deleted = service.deleteProfile(profileId.data);
    if (!deleted) return res.status(404).json({ error: "Profile not found" });
    res.json({ ok: true });
  });

  router.post("/profiles/:profileId/admin", async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile id" });
    const parsed = setAdminSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid admin request" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (auth.profileId === profileId.data && !config.adminBrowserUids.has(auth.browserUid) && !parsed.data.adminEnabled) {
      return res.status(400).json({ error: "Cannot remove your only admin access" });
    }

    try {
      res.json(service.setProfileAdminEnabled(profileId.data, parsed.data.adminEnabled, config.adminBrowserUids));
    } catch (error) {
      if (error instanceof ProfileNotFoundError) return res.status(404).json({ error: "Profile not found" });
      throw error;
    }
  });

  return router;
}
