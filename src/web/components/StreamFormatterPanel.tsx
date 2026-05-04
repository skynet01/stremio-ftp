import { useMemo, useState } from "react";
import { DEFAULT_STREAM_DESCRIPTION_TEMPLATE, DEFAULT_STREAM_NAME_TEMPLATE, renderStreamTemplate } from "../../shared/streamFormatter.js";
import { field, filledClass, Notice } from "./ui.js";

const PREVIEW_CONTEXT = {
  addon: {
    name: "Stremio FTP Addon",
  },
  stream: {
    mediaId: 42,
    serverId: 1,
    serverName: "Server 1",
    serverPrefix: "Server 1 - ",
    filename: "The.Matrix.1999.2160p.mkv",
    path: "/Movies/The.Matrix.1999.2160p.mkv",
    extension: ".mkv",
    quality: "2160p",
    size: 5_368_709_120,
    deliveryMode: "proxy",
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
  const previewContext = useMemo(
    () => ({
      ...PREVIEW_CONTEXT,
      addon: { name: addonName.trim() || PREVIEW_CONTEXT.addon.name },
    }),
    [addonName],
  );
  const previewName = renderStreamTemplate(streamNameTemplate, previewContext, "name");
  const previewDescription = renderStreamTemplate(streamDescriptionTemplate, previewContext, "description");

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
                  onChange={(event) => onStreamDescriptionTemplateChange(event.currentTarget.value)}
                />,
              )}
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
