export function publicManifest() {
  return {
    id: "community.stremio-ftp",
    version: "0.1.0",
    name: "FTP Streams",
    description: "Stream movies and series episodes from your configured FTP server.",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: true },
  };
}

export function tokenManifest() {
  return {
    ...publicManifest(),
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}
