import { Router, type Request } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { countryCodeFromRequest } from "../http/requestMetadata.js";
import type { ProfileScanStatus } from "../scanner/scanQueue.js";
import type { ScanQueue } from "../scanner/scanQueue.js";
import { ProfileNotFoundError, ProfileService, type FtpServer, type SharedIndexGroup } from "../profiles/profileService.js";

const adminAuthSchema = z.object({
  browserUid: z.string().min(8),
  passphrase: z.string().min(8),
});
const setAdminSchema = adminAuthSchema.extend({
  adminEnabled: z.boolean(),
});
const bulkAdminSchema = adminAuthSchema.extend({
  profileIds: z.array(z.number().int().positive()).min(1).max(100),
  action: z.enum(["delete", "rescan", "cancel_scan", "convert_to_proxy"]),
});
const profileIdSchema = z.coerce.number().int().positive();
const groupIdSchema = z.coerce.number().int().positive();
const sharedIndexCreateSchema = adminAuthSchema.extend({
  profileId: z.number().int().positive(),
  serverId: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  keyHint: z.string().trim().min(1).max(48).optional(),
  enabled: z.boolean().optional(),
  autoLinkImports: z.boolean().optional(),
});
const sharedIndexUpdateSchema = adminAuthSchema.extend({
  name: z.string().trim().min(1).max(120).optional(),
  keyHint: z.string().trim().min(1).max(48).optional(),
  enabled: z.boolean().optional(),
  autoLinkImports: z.boolean().optional(),
});
const sharedIndexServerTargetSchema = adminAuthSchema.extend({
  profileId: z.number().int().positive(),
  serverId: z.number().int().positive(),
});

function urls(baseUrl: string, token: string) {
  const manifestUrl = `${baseUrl}/u/${token}/manifest.json`;
  return {
    manifestUrl,
    stremioInstallUrl: manifestUrl.replace(/^https?:\/\//, "stremio://"),
  };
}

function isDraftFtpConfig(ftpConfig: { username?: string | null; password?: string | null }) {
  return !ftpConfig.username?.trim() || !ftpConfig.password;
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
    if (!config.superAdminBrowserUids.has(parsed.data.browserUid)) {
      return { ok: false as const, status: 403, error: "Admin access required" };
    }
    return { ok: true as const, profileId: unlocked.profileId, browserUid: parsed.data.browserUid };
  }

  router.post("/profiles", async (req, res) => {
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const list = service.listAdminProfileSummaries(config.adminBrowserUids);
    const profiles = list.profiles.map((profile) => {
      const scanStatuses = service.listFtpServers(profile.id).map((server) => scanQueue.getServerScanStatus(profile.id, server.id));
      const ftpServerDetails = service.listFtpServers(profile.id).map((server) => ({
        id: server.id,
        name: server.name,
        host: server.ftpConfig?.host ?? null,
        sharedIndex: server.sharedIndex,
      }));
      const activeScans = scanStatuses.filter((scanStatus) => scanStatus.status === "running").length;
      const queuedScans = scanStatuses.filter((scanStatus) => scanStatus.status === "queued").length;
      return {
        ...profile,
        ftpServerDetails,
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

  router.post("/shared-index-groups", async (req, res) => {
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    res.json({ groups: service.listSharedIndexGroups().map((group) => sharedIndexGroupView(service, scanQueue, group)) });
  });

  router.post("/shared-index-groups/create", async (req, res) => {
    const parsed = sharedIndexCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid shared index group request" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const created = service.createSharedIndexGroupFromServer(parsed.data.profileId, parsed.data.serverId, {
        name: parsed.data.name,
        keyHint: parsed.data.keyHint,
        enabled: parsed.data.enabled,
        autoLinkImports: parsed.data.autoLinkImports,
      });
      res.json({ group: sharedIndexGroupView(service, scanQueue, created.group), sharedIndexKey: created.sharedIndexKey });
    } catch (error) {
      handleSharedIndexError(error, res);
    }
  });

  router.post("/shared-index-groups/:groupId/update", async (req, res) => {
    const groupId = groupIdSchema.safeParse(req.params.groupId);
    if (!groupId.success) return res.status(400).json({ error: "Invalid shared index group id" });
    const parsed = sharedIndexUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid shared index group request" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const group = service.updateSharedIndexGroup(groupId.data, {
        name: parsed.data.name,
        keyHint: parsed.data.keyHint,
        enabled: parsed.data.enabled,
        autoLinkImports: parsed.data.autoLinkImports,
      });
      res.json({ group: sharedIndexGroupView(service, scanQueue, group) });
    } catch (error) {
      handleSharedIndexError(error, res);
    }
  });

  router.post("/shared-index-groups/:groupId/rotate-key", async (req, res) => {
    const groupId = groupIdSchema.safeParse(req.params.groupId);
    if (!groupId.success) return res.status(400).json({ error: "Invalid shared index group id" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const rotated = service.rotateSharedIndexGroupKey(groupId.data);
      res.json({ group: sharedIndexGroupView(service, scanQueue, rotated.group), sharedIndexKey: rotated.sharedIndexKey });
    } catch (error) {
      handleSharedIndexError(error, res);
    }
  });

  router.post("/shared-index-groups/:groupId/link-server", async (req, res) => {
    const groupId = groupIdSchema.safeParse(req.params.groupId);
    if (!groupId.success) return res.status(400).json({ error: "Invalid shared index group id" });
    const parsed = sharedIndexServerTargetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid shared index server request" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      service.linkServerToSharedGroup(parsed.data.profileId, parsed.data.serverId, groupId.data);
      const group = service.getSharedIndexGroup(groupId.data);
      if (!group) return res.status(404).json({ error: "Shared index group not found" });
      res.json({ group: sharedIndexGroupView(service, scanQueue, group) });
    } catch (error) {
      handleSharedIndexError(error, res);
    }
  });

  router.post("/shared-index-groups/:groupId/unlink-server", async (req, res) => {
    const groupId = groupIdSchema.safeParse(req.params.groupId);
    if (!groupId.success) return res.status(400).json({ error: "Invalid shared index group id" });
    const parsed = sharedIndexServerTargetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid shared index server request" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const server = service.getFtpServer(parsed.data.profileId, parsed.data.serverId);
      if (!server.sharedIndex || server.sharedIndex.id !== groupId.data) return res.status(400).json({ error: "Server is not linked to this shared index group" });
      service.unlinkServerFromSharedGroup(parsed.data.profileId, parsed.data.serverId);
      const group = service.getSharedIndexGroup(groupId.data);
      if (!group) return res.status(404).json({ error: "Shared index group not found" });
      res.json({ group: sharedIndexGroupView(service, scanQueue, group) });
    } catch (error) {
      handleSharedIndexError(error, res);
    }
  });

  router.post("/shared-index-groups/:groupId/master", async (req, res) => {
    const groupId = groupIdSchema.safeParse(req.params.groupId);
    if (!groupId.success) return res.status(400).json({ error: "Invalid shared index group id" });
    const parsed = sharedIndexServerTargetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid shared index server request" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const group = service.setSharedIndexGroupMaster(groupId.data, parsed.data.profileId, parsed.data.serverId);
      res.json({ group: sharedIndexGroupView(service, scanQueue, group) });
    } catch (error) {
      handleSharedIndexError(error, res);
    }
  });

  router.post("/shared-index-groups/:groupId/rescan", async (req, res) => {
    const groupId = groupIdSchema.safeParse(req.params.groupId);
    if (!groupId.success) return res.status(400).json({ error: "Invalid shared index group id" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const group = service.getSharedIndexGroup(groupId.data);
      if (!group) return res.status(404).json({ error: "Shared index group not found" });
      res.json({ group: sharedIndexGroupView(service, scanQueue, group), scanStatus: scanQueue.enqueueSharedIndexScan(groupId.data, "manual") });
    } catch (error) {
      handleSharedIndexError(error, res);
    }
  });

  router.post("/shared-index-groups/:groupId/cancel-scan", async (req, res) => {
    const groupId = groupIdSchema.safeParse(req.params.groupId);
    if (!groupId.success) return res.status(400).json({ error: "Invalid shared index group id" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      const group = service.getSharedIndexGroup(groupId.data);
      if (!group) return res.status(404).json({ error: "Shared index group not found" });
      res.json({ group: sharedIndexGroupView(service, scanQueue, group), scanStatus: scanQueue.cancelSharedIndexScan(groupId.data) });
    } catch (error) {
      handleSharedIndexError(error, res);
    }
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

  router.post("/profiles/:profileId/rescan", async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile id" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
      res.json({ profileId: profileId.data, scanStatus: scanQueue.enqueueProfileScan(profileId.data, "manual") });
    } catch (error) {
      if (error instanceof ProfileNotFoundError) return res.status(404).json({ error: "Profile not found" });
      throw error;
    }
  });

  router.post("/profiles/bulk", async (req, res) => {
    const parsed = bulkAdminSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid bulk admin request" });
    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const profileIds = [...new Set(parsed.data.profileIds)];
    try {
      if (parsed.data.action === "delete") {
        const deleted = profileIds.reduce((count, profileId) => count + (service.deleteProfile(profileId) ? 1 : 0), 0);
        return res.json({ action: parsed.data.action, profileIds, deleted, summary: { profiles: profileIds.length, deleted } });
      }

      if (parsed.data.action === "rescan") {
        const scans = bulkScanTargets(service, profileIds).flatMap(({ profileId, servers }) =>
          servers.map((server) => ({ profileId, serverId: server.id, serverName: server.name, scanStatus: scanQueue.enqueueProfileScan(profileId, "manual", server.id) })),
        );
        return res.json({ action: parsed.data.action, profileIds, scans, summary: scanSummary(profileIds, scans, skippedProfileCount(service, profileIds)) });
      }

      if (parsed.data.action === "cancel_scan") {
        const targets = bulkScanTargets(service, profileIds);
        const pendingRetries = targets.reduce((sum, { servers }) => sum + servers.filter((server) => server.pendingScanAfter).length, 0);
        const scans = targets.flatMap(({ profileId, servers }) =>
          servers.map((server) => {
            if (server.pendingScanAfter) service.clearPendingScan(profileId, server.id);
            return { profileId, serverId: server.id, serverName: server.name, scanStatus: scanQueue.cancelServerScan(profileId, server.id) };
          }),
        );
        return res.json({ action: parsed.data.action, profileIds, scans, summary: scanSummary(profileIds, scans, skippedProfileCount(service, profileIds), pendingRetries) });
      }

      let serversConverted = 0;
      const converted = profileIds.reduce((count, profileId) => {
        const result = service.setProfileAndServersStreamDeliveryMode(profileId, "proxy");
        serversConverted += result.serversUpdated;
        return count + 1;
      }, 0);
      return res.json({ action: parsed.data.action, profileIds, converted, summary: { profiles: profileIds.length, converted, servers: serversConverted } });
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

    try {
      res.json(service.setProfileAdminEnabled(profileId.data, parsed.data.adminEnabled, config.adminBrowserUids));
    } catch (error) {
      if (error instanceof ProfileNotFoundError) return res.status(404).json({ error: "Profile not found" });
      throw error;
    }
  });

  return router;
}

function bulkScanTargets(service: ProfileService, profileIds: number[]) {
  return profileIds.map((profileId) => ({
    profileId,
    servers: configuredFtpServers(service, profileId),
  }));
}

function configuredFtpServers(service: ProfileService, profileId: number): FtpServer[] {
  return service.listFtpServers(profileId).filter((server) => server.ftpConfig && !isDraftFtpConfig(server.ftpConfig));
}

function skippedProfileCount(service: ProfileService, profileIds: number[]) {
  return bulkScanTargets(service, profileIds).filter(({ servers }) => servers.length === 0).length;
}

function scanSummary(
  profileIds: number[],
  scans: Array<{ scanStatus: ProfileScanStatus }>,
  skippedProfiles: number,
  stoppedPendingRetries = 0,
) {
  return {
    profiles: profileIds.length,
    servers: scans.length,
    queued: scans.filter(({ scanStatus }) => scanStatus.status === "queued").length,
    running: scans.filter(({ scanStatus }) => scanStatus.status === "running" && scanStatus.message !== "Halting scan.").length,
    halting: scans.filter(({ scanStatus }) => scanStatus.status === "running" && scanStatus.message === "Halting scan.").length,
    cancelled: stoppedPendingRetries + scans.filter(({ scanStatus }) => scanStatus.status === "cancelled").length,
    skipped: skippedProfiles + scans.filter(({ scanStatus }) => scanStatus.status === "skipped").length,
    failed: scans.filter(({ scanStatus }) => scanStatus.status === "failed").length,
  };
}

function sharedIndexGroupView(service: ProfileService, scanQueue: ScanQueue, group: SharedIndexGroup) {
  return {
    ...group,
    linkedServerCount: group.linkedServers,
    linkedServers: service.listSharedIndexLinkedServers(group.id),
    masterServer: service.sharedIndexGroupMaster(group.id),
    scanStatus: scanQueue.getSharedIndexScanStatus(group.id),
  };
}

function handleSharedIndexError(error: unknown, res: { status(code: number): { json(body: object): unknown } }) {
  if (error instanceof ProfileNotFoundError) return res.status(404).json({ error: "Profile or FTP server not found" });
  if (error instanceof Error) return res.status(400).json({ error: error.message });
  throw error;
}
