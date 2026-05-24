export type ActiveProxyStream = {
  id: string;
  routeKind: "profile" | "shared";
  method: string;
  filename: string;
  sizeBytes: number | null;
  range: string | null;
  status: number;
  profileId: number | null;
  serverId: number | null;
  sharedIndexGroupId: number | null;
  remoteAddress: string | null;
  userAgent: string | null;
  startedAt: string;
  durationSeconds: number;
};

type StartProxyStreamInput = Omit<ActiveProxyStream, "id" | "startedAt" | "durationSeconds">;

type StoredProxyStream = StartProxyStreamInput & {
  id: string;
  startedAtMs: number;
  startedAt: string;
};

export class ProxyStreamTracker {
  private readonly activeStreams = new Map<string, StoredProxyStream>();
  private nextId = 1;

  start(input: StartProxyStreamInput) {
    const id = String(this.nextId++);
    this.activeStreams.set(id, {
      ...input,
      id,
      startedAtMs: Date.now(),
      startedAt: new Date().toISOString(),
    });
    return id;
  }

  finish(id: string | null) {
    if (!id) return;
    this.activeStreams.delete(id);
  }

  snapshot(): { activeStreams: ActiveProxyStream[]; summary: { active: number; profile: number; shared: number } } {
    const now = Date.now();
    const activeStreams = [...this.activeStreams.values()].map(({ startedAtMs, ...stream }) => ({
      ...stream,
      durationSeconds: Math.max(0, Math.round((now - startedAtMs) / 1000)),
    }));
    return {
      activeStreams,
      summary: {
        active: activeStreams.length,
        profile: activeStreams.filter((stream) => stream.routeKind === "profile").length,
        shared: activeStreams.filter((stream) => stream.routeKind === "shared").length,
      },
    };
  }
}
