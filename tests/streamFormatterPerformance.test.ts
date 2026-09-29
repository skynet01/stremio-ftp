import { describe, expect, it } from "vitest";
import { DEFAULT_STREAM_DESCRIPTION_TEMPLATE, renderStreamTemplate } from "../src/shared/streamFormatter";

const TEMPLATE_CAP = 12_000;

const context = {
  addon: { name: "Archive 3D" },
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
    visualTags: ["HDR"],
    "3dtype": "",
    threeDType: "",
    encode: "HEVC",
    audioTags: ["TrueHD", "Atmos"],
    audioChannels: ["7.1"],
    title: "The Matrix",
    library: false,
  },
};

function fill(pattern: string, length: number) {
  return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}

function elapsed(run: () => void) {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("stream formatter performance", () => {
  it("parses unclosed-brace templates at the length cap in linear time", () => {
    const templates = ["{", "{[", "{(", "{'", "{\"", "{[(", "{\\\"", "{'{\"", "{[{(]{)"].map((pattern) => fill(pattern, TEMPLATE_CAP));

    const duration = elapsed(() => {
      for (const template of templates) renderStreamTemplate(template, context, "description");
    });

    expect(renderStreamTemplate(templates[0], context, "description")).toBe(templates[0]);
    expect(duration).toBeLessThan(250);
  });

  it("renders templates over the length cap as the default template without parsing them", () => {
    const template = "{".repeat(50_000);
    let rendered = "";

    const duration = elapsed(() => {
      rendered = renderStreamTemplate(template, context, "description");
    });

    expect(rendered).toBe(renderStreamTemplate(DEFAULT_STREAM_DESCRIPTION_TEMPLATE, context, "description"));
    expect(duration).toBeLessThan(200);
  });

  it("normalizes names with long whitespace runs in linear time", () => {
    const template = `a${"\n".repeat(TEMPLATE_CAP - 2)}b`;
    let rendered = "";

    const duration = elapsed(() => {
      for (let round = 0; round < 20; round += 1) rendered = renderStreamTemplate(template, context, "name");
    });

    expect(rendered).toBe(template);
    expect(duration).toBeLessThan(300);
  });

  it("renders a long realistic template repeatedly within budget", () => {
    const section =
      "{stream.title::exists::and::stream.library::isfalse[\"✎  {stream.title::title::truncate(35)}\"||\"\"]}{stream.visualTags::exists[\" {stream.visualTags::sort::join(' · ')}\"||\"\"]}{stream.size::>0[\" {stream.size::sbytes}\"||\"\"]}\n";
    const template = section.repeat(Math.floor(TEMPLATE_CAP / section.length));
    expect(template.length).toBeGreaterThan(TEMPLATE_CAP - section.length);

    const duration = elapsed(() => {
      for (let round = 0; round < 200; round += 1) renderStreamTemplate(template, context, "description");
    });

    expect(renderStreamTemplate(template, context, "description").split("\n")[0]).toBe("✎  The Matrix HDR 5GB");
    expect(duration).toBeLessThan(2000);
  });
});
