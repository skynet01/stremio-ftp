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
    container: "mkv",
    quality: "2160p",
    resolution: "2160p",
    size: 5368709120,
    deliveryMode: "proxy",
    videoTags: "HDR HEVC",
    visualTags: ["HDR"],
    encode: "HEVC",
    audioTags: ["TrueHD", "Atmos"],
    audioChannels: ["7.1"],
    library: false,
    title: "The Matrix",
    year: "1999",
    seasonPack: false,
    seasons: [],
    episodes: [],
    seasonEpisode: [],
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
    expect(renderStreamTemplate("{stream.videoTags}{tools.newLine}{stream.audioTags}", context, "description")).toBe("HDR HEVC\nTrueHD Atmos");
  });

  it("renders AIOStreams-style aliases, arrays, modifiers, and conditionals", () => {
    const template =
      "{config.addonName}{tools.newLine}{stream.title::exists::and::stream.library::isfalse[\"{stream.title::title::truncate(35)}\"||\"\"]}{stream.year::exists[\" ({stream.year})\"||\"\"]}{tools.newLine}{stream.visualTags::exists[\"{stream.visualTags::sort::join(' · ')} {stream.encode}\"||\"\"]}{tools.newLine}{stream.audioTags::exists[\"{stream.audioTags::lsort::join(' · ')} {stream.audioChannels::join(' · ')}\"||\"\"]}{tools.newLine}{stream.size::>0[\"{stream.size::sbytes}\"||\"\"]}{service.cached::isfalse::or::stream.type::=p2p::and::stream.seeders::>0[\" seeders {stream.seeders}\"||\"\"]}";

    expect(renderStreamTemplate(template, context, "description")).toBe(
      "Archive 3D\nThe Matrix (1999)\nHDR HEVC\nAtmos · TrueHD 7.1\n5GB",
    );
  });

  it("removes marked lines and ignores unsupported AIOStreams fields", () => {
    const template = "{stream.message::~Download[\"{tools.removeLine}\"||\"\"]}{stream.seeders::>0[\"Seeders {stream.seeders}\"||\"\"]}{stream.filename}";

    expect(renderStreamTemplate(template, context, "description")).toBe("The.Matrix.1999.2160p.HDR.mkv");
  });

  it("supports chained AIOStreams conditional negation", () => {
    expect(renderStreamTemplate("{stream.visualTags::=IMAX::isfalse[\"not imax\"||\"imax\"]}", context, "description")).toBe("not imax");
    expect(renderStreamTemplate("{stream.visualTags::~HDR::istrue[\"hdr\"||\"\"]}", context, "description")).toBe("hdr");
  });
});
