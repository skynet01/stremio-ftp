import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAM_DESCRIPTION_TEMPLATE,
  DEFAULT_STREAM_NAME_TEMPLATE,
  renderStreamTemplate,
  streamAudioTags,
  streamVideoTags,
} from "../src/shared/streamFormatter";

const context = {
  addon: {
    name: "Archive 3D",
  },
  stream: {
    mediaId: 42,
    serverId: 2,
    serverName: "Server 2",
    serverPrefix: "Server 2 - ",
    filename: "The.Matrix.1999.2160p.HDR.mkv",
    path: "/Movies/The.Matrix.1999.2160p.HDR.mkv",
    extension: ".mkv",
    quality: "2160p",
    size: 5368709120,
    deliveryMode: "proxy",
    videoTags: "HDR HEVC",
    audioTags: "TrueHD Atmos 7.1",
  },
};

describe("stream formatter", () => {
  it("renders default stream name and description templates", () => {
    expect(renderStreamTemplate(DEFAULT_STREAM_NAME_TEMPLATE, context, "name")).toBe("FTP Server 2 - 2160p");
    expect(renderStreamTemplate(DEFAULT_STREAM_DESCRIPTION_TEMPLATE, context, "description")).toBe(
      "Server 2\nThe.Matrix.1999.2160p.HDR.mkv\n5.0 GB",
    );
  });

  it("renders variables, tools, and modifiers", () => {
    const template = "{addon.name} {stream.serverName::upper}{tools.newLine}{stream.filename::title}{tools.newLine}{stream.size::bytes}";

    expect(renderStreamTemplate(template, context, "description")).toBe(
      "Archive 3D SERVER 2\nThe.Matrix.1999.2160p.HDR.Mkv\n5.0 GB",
    );
  });

  it("falls back when a template renders empty", () => {
    expect(renderStreamTemplate("{stream.missing}", context, "name")).toBe("FTP Server 2 - 2160p");
  });

  it("removes empty lines from missing values in descriptions", () => {
    expect(
      renderStreamTemplate("{stream.missing}{tools.newLine}{stream.filename}{tools.newLine}{stream.size::bytes}", context, "description"),
    ).toBe("The.Matrix.1999.2160p.HDR.mkv\n5.0 GB");
  });

  it("detects video and audio tags from filenames", () => {
    const filename = "The.Matrix.1999.2160p.DV.HDR10.HEVC.TrueHD.Atmos.7.1.Remux.mkv";

    expect(streamVideoTags(filename)).toBe("Dolby Vision HDR10 HEVC Remux");
    expect(streamAudioTags(filename)).toBe("Atmos TrueHD 7.1");
    expect(renderStreamTemplate("{stream.videoTags}{tools.newLine}{stream.audioTags}", context, "description")).toBe(
      "HDR HEVC\nTrueHD Atmos 7.1",
    );
  });
});
