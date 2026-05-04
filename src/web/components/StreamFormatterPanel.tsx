import { useMemo, useState } from "react";
import { DEFAULT_STREAM_DESCRIPTION_TEMPLATE, DEFAULT_STREAM_NAME_TEMPLATE, renderStreamTemplate } from "../../shared/streamFormatter.js";
import { field, filledClass, Notice } from "./ui.js";

type FormatterTarget = "name" | "description";

const FORMATTER_TOKENS = [
  { label: "Addon", token: "{addon.name}" },
  { label: "Server", token: "{stream.serverName}" },
  { label: "Title", token: "{stream.title}" },
  { label: "Year", token: "{stream.year}" },
  { label: "Quality", token: "{stream.quality}" },
  { label: "Filename", token: "{stream.filename}" },
  { label: "Size", token: "{stream.size::bytes}" },
  { label: "Video tags", token: "{stream.videoTags}" },
  { label: "Visual tags", token: "{stream.visualTags::join(' · ')}" },
  { label: "Encode", token: "{stream.encode}" },
  { label: "Audio tags", token: "{stream.audioTags}" },
  { label: "Audio channels", token: "{stream.audioChannels::join(' · ')}" },
  { label: "Line break", token: "{tools.newLine}" },
];

const PREVIEW_CONTEXT = {
  config: {
    addonName: "Stremio FTP Addon",
  },
  addon: {
    name: "Stremio FTP Addon",
  },
  service: {
    id: "ftp",
    shortName: "FTP",
    name: "FTP",
    cached: true,
  },
  metadata: {},
  debug: {},
  stream: {
    mediaId: 42,
    serverId: 1,
    serverName: "Server 1",
    serverPrefix: "Server 1 - ",
    filename: "The.Matrix.1999.2160p.DV.HDR10.HEVC.TrueHD.Atmos.7.1.mkv",
    path: "/Movies/The.Matrix.1999.2160p.DV.HDR10.HEVC.TrueHD.Atmos.7.1.mkv",
    extension: ".mkv",
    container: "mkv",
    quality: "2160p",
    resolution: "2160p",
    size: 5_368_709_120,
    folderSize: 5_368_709_120,
    bitrate: 21_000_000,
    duration: 8_160,
    deliveryMode: "proxy",
    type: "http",
    proxied: true,
    library: false,
    indexer: "Server 1",
    message: "",
    folderName: "",
    videoTags: "Dolby Vision HDR10 HEVC",
    visualTags: ["DV", "HDR10"],
    encode: "HEVC",
    audioTags: ["TrueHD", "Atmos"],
    audioChannels: ["7.1"],
    languages: [],
    languageCodes: [],
    smallLanguageCodes: [],
    subtitles: [],
    title: "The Matrix",
    year: "1999",
    releaseGroup: "FTP",
    seasonPack: false,
    seasons: [],
    episodes: [],
    seasonEpisode: [],
    seeders: 0,
    private: false,
    age: "",
    seadex: false,
    seadexBest: false,
    rseMatched: [],
  },
};

export function StreamFormatterPanel({
  addonName,
  streamNameTemplate,
  streamDescriptionTemplate,
  profileReady,
  message,
  onStreamNameTemplateChange,
  onStreamDescriptionTemplateChange,
  onSave,
}: {
  addonName: string;
  streamNameTemplate: string;
  streamDescriptionTemplate: string;
  profileReady: boolean;
  message: string;
  onStreamNameTemplateChange: (value: string) => void;
  onStreamDescriptionTemplateChange: (value: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [formatterTarget, setFormatterTarget] = useState<FormatterTarget>("description");
  const previewContext = useMemo(
    () => ({
      ...PREVIEW_CONTEXT,
      config: { addonName: addonName.trim() || PREVIEW_CONTEXT.addon.name },
      addon: { name: addonName.trim() || PREVIEW_CONTEXT.addon.name },
    }),
    [addonName],
  );
  const previewName = renderStreamTemplate(streamNameTemplate, previewContext, "name");
  const previewDescription = renderStreamTemplate(streamDescriptionTemplate, previewContext, "description");
  function insertToken(token: string) {
    if (formatterTarget === "name") {
      onStreamNameTemplateChange(`${streamNameTemplate}${token}`);
      return;
    }
    onStreamDescriptionTemplateChange(`${streamDescriptionTemplate}${token}`);
  }

  return (
    <div className="stream-formatter">
      <button type="button" className="stream-formatter-trigger" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        Stream formatter settings
      </button>
      {open ? (
        <div className="stream-formatter-body">
          <div className="stream-formatter-grid">
            <div className="stream-formatter-inputs">
              {field(
                "Stream name formatter",
                "streamNameTemplate",
                <textarea
                  id="streamNameTemplate"
                  className={filledClass(streamNameTemplate)}
                  value={streamNameTemplate}
                  rows={3}
                  placeholder={DEFAULT_STREAM_NAME_TEMPLATE}
                  onFocus={() => setFormatterTarget("name")}
                  onChange={(event) => onStreamNameTemplateChange(event.currentTarget.value)}
                />,
              )}
              {field(
                "Stream description formatter",
                "streamDescriptionTemplate",
                <textarea
                  id="streamDescriptionTemplate"
                  className={filledClass(streamDescriptionTemplate)}
                  value={streamDescriptionTemplate}
                  rows={5}
                  placeholder={DEFAULT_STREAM_DESCRIPTION_TEMPLATE}
                  onFocus={() => setFormatterTarget("description")}
                  onChange={(event) => onStreamDescriptionTemplateChange(event.currentTarget.value)}
                />,
              )}
              <div className="formatter-token-group" aria-label="Formatter tags">
                {FORMATTER_TOKENS.map((item) => (
                  <button type="button" className="formatter-token" key={item.token} onClick={() => insertToken(item.token)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="button-row stream-formatter-actions">
                <button type="button" className="primary-button" disabled={!profileReady} onClick={onSave}>
                  Save stream formatter
                </button>
              </div>
            </div>
            <div className="stream-preview" aria-label="Stream formatter preview">
              <span className="section-label">Preview</span>
              <div className="stream-preview-title">{previewName}</div>
              <div className="stream-preview-lines">
                {previewDescription.split("\n").map((line, index) => (
                  <span key={`${line}-${index}`}>{line}</span>
                ))}
              </div>
            </div>
          </div>
          <Notice className="stream-formatter-notice">{message}</Notice>
        </div>
      ) : null}
    </div>
  );
}
