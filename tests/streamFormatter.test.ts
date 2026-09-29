import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAM_DESCRIPTION_TEMPLATE,
  DEFAULT_STREAM_NAME_TEMPLATE,
  MAX_STREAM_FORMATTER_TEMPLATE_LENGTH,
  renderStreamTemplate,
  stream3DType,
  streamAudioChannels,
  streamAudioTagList,
  streamAudioTags,
  streamEncode,
  streamVideoTagList,
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
    "3dtype": "",
    threeDType: "",
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

  it("detects 3D type tokens from filenames", () => {
    expect(stream3DType("Avatar.2009.2160p.FSBS.mkv")).toBe("Full SBS");
    expect(stream3DType("Avatar.2009.2160p.Full-SBS.mkv")).toBe("Full SBS");
    expect(stream3DType("Avatar.2009.2160p.Full.Side-by-Side.mkv")).toBe("Full SBS");
    expect(stream3DType("Avatar.2009.1080p.HSBS.mkv")).toBe("Half SBS");
    expect(stream3DType("Avatar.2009.1080p.Half.SideBySide.mkv")).toBe("Half SBS");
    expect(stream3DType("Avatar.2009.1080p.Half_OU.mkv")).toBe("Half OU");
    expect(stream3DType("Avatar.2009.2160p.FOU.mkv")).toBe("Full OU");
    expect(stream3DType("Avatar.2009.2160p.Top-and-Bottom.mkv")).toBe("OU");
    expect(stream3DType("Avatar.2009.2160p.Half-TAB.mkv")).toBe("Half OU");
    expect(stream3DType("Avatar.2009.2160p.Full.Top.Bottom.mkv")).toBe("Full OU");
    expect(stream3DType("Avatar.2009.2160p.Over_Under.mkv")).toBe("OU");
    expect(stream3DType("Avatar.2009.2160p.TAB.mkv")).toBe("OU");
    expect(stream3DType("Avatar.2009.1080p.MVC.mkv")).toBe("MVC");
    expect(stream3DType("Avatar.2009.3D.mkv")).toBe("3D");
    expect(stream3DType("VR.Movie.180.Full-SBS.mp4")).toBe("180 Full SBS");
    expect(stream3DType("VR.Movie.VR360.Half-OU.mp4")).toBe("360 Half OU");
    expect(stream3DType("The.Matrix.1999.2160p.HEVC.mkv")).toBe("");
  });

  it("extracts video, encode, audio, channel, and 3D tags from filenames", () => {
    const tags = (filename: string) => [
      streamVideoTagList(filename),
      streamEncode(filename),
      streamAudioTagList(filename),
      streamAudioChannels(filename),
      stream3DType(filename),
    ];

    expect(tags("The.Matrix.1999.2160p.UHD.BluRay.DV.HDR10.HEVC.TrueHD.Atmos.7.1-GRP.mkv")).toEqual([["DV", "HDR10"], "HEVC", ["Atmos", "TrueHD"], ["7.1"], ""]);
    expect(tags("Movie.2020.IMAX.2160p.WEB-DL.DoVi.HDR10+.DDP5.1.Atmos.H.265.mkv")).toEqual([["IMAX", "DV", "HDR10"], "HEVC", ["Atmos"], [], ""]);
    expect(tags("Show.S01E02.1080p.WEB.x264.AAC.2.0.mkv")).toEqual([[], "AVC", ["AAC"], ["2.0"], ""]);
    expect(tags("Film.2019.1080p.BluRay.Remux.AVC.DTS-HD.MA.5.1.mkv")).toEqual([["Remux"], "AVC", ["DTS-HD MA", "DTS"], ["5.1"], ""]);
    expect(tags("Film.2019.2160p.AV1.DTS-X.FLAC.AC3.mkv")).toEqual([[], "AV1", ["DTS-X", "DTS", "DD", "FLAC"], [], ""]);
    expect(tags("VR.Movie.180.VR-SBS.mp4")).toEqual([[], "", [], [], "180 VR SBS"]);
    expect(tags("VR.Movie.VR.360.OU.mp4")).toEqual([[], "", [], [], "360 OU"]);
    expect(tags("3D.Movie.2012.1080p.Half.Over.Under.mkv")).toEqual([[], "", [], [], "Half OU"]);
  });

  it("renders 3D type formatter aliases", () => {
    const threeDContext = {
      ...context,
      stream: {
        ...context.stream,
        filename: "Avatar.2009.2160p.Full-SBS.mkv",
        "3dtype": "Full SBS",
        threeDType: "Full SBS",
      },
    };

    expect(renderStreamTemplate("3D - {stream.3dtype} - {stream.quality}", threeDContext, "name")).toBe("3D - Full SBS - 2160p");
    expect(renderStreamTemplate("{stream.threeDType}", threeDContext, "name")).toBe("Full SBS");
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

const movie = {
  addon: { name: "Archive 3D" },
  config: { addonName: "Archive 3D" },
  service: { id: "ftp", shortName: "FTP", name: "FTP", cached: true },
  metadata: {},
  debug: {},
  stream: {
    mediaId: 42,
    serverId: 2,
    serverName: "Server 2",
    serverPrefix: "Server 2 - ",
    type: "http",
    proxied: true,
    library: false,
    message: "",
    filename: "The.Matrix.1999.2160p.UHD.BluRay.DV.HDR10.HEVC.TrueHD.Atmos.7.1-GRP.mkv",
    path: "/Movies/The.Matrix.1999.2160p.mkv",
    extension: ".mkv",
    quality: "2160p",
    size: 58368709120,
    bitrate: 48_500_000,
    duration: 8160,
    deliveryMode: "proxy",
    videoTags: "Dolby Vision HDR10",
    visualTags: ["DV", "HDR10"],
    "3dtype": "",
    threeDType: "",
    encode: "HEVC",
    audioTags: ["TrueHD", "Atmos"],
    audioChannels: ["7.1"],
    title: "The Matrix",
    year: "1999",
    releaseGroup: "GRP",
    seasons: [],
    episodes: [],
    seasonEpisode: [],
    seeders: 0,
  },
};

const episode = {
  ...movie,
  stream: {
    ...movie.stream,
    filename: "The.Office.US.S02E05.Halloween.IMAX.1080p.WEB-DL.DDP5.1.H.264.mkv",
    quality: "1080p",
    size: 1288490188,
    visualTags: ["IMAX"],
    videoTags: "IMAX",
    encode: "AVC",
    audioTags: ["DD+"],
    audioChannels: ["5.1"],
    title: "the office us",
    year: "",
    seasons: [2],
    episodes: [5],
    seasonEpisode: ["S02", "E05"],
    message: "Download pending",
    "3dtype": "Half SBS",
    threeDType: "Half SBS",
  },
};

const PRODUCTION_DESCRIPTION =
  "{stream.title::exists::and::stream.library::isfalse[\"✎  {stream.title::title::truncate(35)}\"||\"\"]}{stream.year::exists::and::stream.episodes::exists::isfalse::and::stream.seasons::exists::isfalse[\" ({stream.year})\"||\"\"]}{stream.seasonEpisode::exists[\"  {stream.seasonEpisode::join('·')::replace('E','ᴇ')}\"||\"\"]}\n{stream.visualTags::=IMAX[\"{tools.removeLine}\n\"||\"{tools.removeLine}\n\"]}{stream.encode::exists[\"▣  {stream.encode}  \"||\"\"]}{stream.size::>0[\"{stream.size::sbytes}\"||\"\"]}{stream.message::~Download[\"{tools.removeLine}\"||\"\"]}";

const PRODUCTION_NAME = [
  "{stream.resolution::=2160p[\"𝟰𝗞\"||\"\"]}{stream.resolution::=1440p[\"𝟮𝗞\"||\"\"]}{stream.resolution::=1080p[\"𝗙𝗛𝗗\"||\"\"]}{stream.resolution::=720p[\"𝗛𝗗\"||\"\"]}",
  "{stream.resolution::=Source[\"{stream.container::upper}\"||\"\"]}",
  "{stream.visualTags::~DV::or::stream.visualTags::~HDR10+[\" ✦\"||\"\"]}{stream.visualTags::~IMAX[\" ɪᴍᴀx\"||\"\"]}",
  "{stream.threeDType::exists[\"{tools.newLine}⧉ {stream.threeDType::smallcaps}\"||\"\"]}",
  "{tools.newLine}{stream.serverName::exists::and::stream.proxied::istrue[\"⇄ {stream.serverName::truncate(18)}\"||\"{addon.name::truncate(18)}\"]}",
  "{stream.seasonPack::istrue[\" · ᴘᴀᴄᴋ\"||\"\"]}{stream.releaseGroup::exists::and::stream.releaseGroup::=GRP::isfalse[\" · {stream.releaseGroup::upper}\"||\"\"]}",
  "{stream.audioTags::~Atmos::xor::stream.audioTags::~DTS-X[\"{tools.newLine}◈ {stream.audioTags::sort::join(' ')}\"||\"\"]}",
  "{stream.size::>=53687091200[\" · 🐘\"||\"\"]}{stream.size::<1073741824::and::stream.size::>0[\" · 🪶\"||\"\"]}",
  "{stream.encode::=HEVC[\" · ʜᴇᴠᴄ\"||\"{stream.encode::exists[' · {stream.encode::smallcaps}'||'']}\"]}",
  "{stream.message::exists[\"{tools.newLine}{stream.message}\"||\"\"]}",
].join("");

const LONG_DESCRIPTION = [
  PRODUCTION_DESCRIPTION,
  PRODUCTION_NAME,
  ...Array.from(
    { length: 10 },
    (_, index) =>
      `{stream.visualTags::exists::and::stream.size::>${index}["#${index} {stream.visualTags::sort::join(' · ')} {stream.audioTags::join(' ')::smallcaps}{stream.audioChannels::exists[' ({stream.audioChannels::first})'||'']}"||"{tools.removeLine}"]}`,
  ),
  "{stream.filename::truncate(48)}{tools.newLine}{stream.path::replace('/',' › ')}",
].join("\n");

const DEFAULT_DESCRIPTIONS = [
  "Server 2\nThe.Matrix.1999.2160p.UHD.BluRay.DV.HDR10.HEVC.TrueHD.Atmos.7.1-GRP.mkv\n54 GB",
  "Server 2\nThe.Office.US.S02E05.Halloween.IMAX.1080p.WEB-DL.DDP5.1.H.264.mkv\n1.2 GB",
];

function renderBoth(template: string, kind: "name" | "description" = "description") {
  return [renderStreamTemplate(template, movie, kind), renderStreamTemplate(template, episode, kind)];
}

describe("stream formatter characterization", () => {
  it("renders the production description template", () => {
    expect(renderBoth(PRODUCTION_DESCRIPTION)).toEqual(["✎  The Matrix (1999)\n▣  HEVC  54GB", "✎  The Office Us  S02·ᴇ05"]);
  });

  it("renders a production-style name template", () => {
    expect(PRODUCTION_NAME.length).toBeGreaterThan(1000);
    expect(renderBoth(PRODUCTION_NAME, "name")).toEqual([
      "𝟰𝗞 ✦\n⇄ Server 2\n◈ Atmos TrueHD · 🐘 · ʜᴇᴠᴄ",
      "𝗙𝗛𝗗 ɪᴍᴀx\n⧉ ʜᴀʟғ ꜱʙꜱ\n⇄ Server 2 · ᴀᴠᴄ\nDownload pending",
    ]);
  });

  it("renders a long multi-line production-style description template", () => {
    expect(LONG_DESCRIPTION.length).toBeGreaterThan(3900);
    const numbered = (line: string) => Array.from({ length: 10 }, (_, index) => `#${index} ${line}`);
    expect(renderBoth(LONG_DESCRIPTION)).toEqual([
      [
        "✎  The Matrix (1999)",
        "▣  HEVC  54GB",
        "𝟰𝗞 ✦",
        "⇄ Server 2",
        "◈ Atmos TrueHD · 🐘 · ʜᴇᴠᴄ",
        ...numbered("DV · HDR10 ᴛʀᴜᴇʜᴅ ᴀᴛᴍᴏꜱ (7.1)"),
        "The.Matrix.1999.2160p.UHD.BluRay.DV.HDR10.HEVC.…",
        "› Movies › The.Matrix.1999.2160p.mkv",
      ].join("\n"),
      [
        "✎  The Office Us  S02·ᴇ05",
        "𝗙𝗛𝗗 ɪᴍᴀx",
        "⧉ ʜᴀʟғ ꜱʙꜱ",
        "⇄ Server 2 · ᴀᴠᴄ",
        "Download pending",
        ...numbered("IMAX ᴅᴅ+ (5.1)"),
        "The.Office.US.S02E05.Halloween.IMAX.1080p.WEB-D…",
        "› Movies › The.Matrix.1999.2160p.mkv",
      ].join("\n"),
    ]);
  });

  it("renders string, array, and number modifiers", () => {
    expect(
      renderBoth(
        "{stream.title::upper}|{stream.title::lower}|{stream.title::smallcaps}|{stream.title::title}|{stream.title::length}|{stream.title::reverse}",
      ),
    ).toEqual([
      "THE MATRIX|the matrix|ᴛʜᴇ ᴍᴀᴛʀɪх|The Matrix|10|xirtaM ehT",
      "THE OFFICE US|the office us|ᴛʜᴇ ᴏғғɪᴄᴇ ᴜꜱ|The Office Us|13|su eciffo eht",
    ]);
    expect(
      renderBoth(
        "{stream.visualTags::length}|{stream.visualTags::reverse}|{stream.visualTags::sort}|{stream.visualTags::rsort}|{stream.visualTags::first}|{stream.visualTags::last}|{stream.title::first}|{stream.title::last}",
      ),
    ).toEqual(["2|HDR10 DV|DV HDR10|HDR10 DV|DV|HDR10|T|x", "1|IMAX|IMAX|IMAX|IMAX|IMAX|t|s"]);
    expect(
      renderBoth(
        "{stream.size::bytes}|{stream.size::sbytes}|{stream.size::rbytes10}|{stream.bitrate::bitrate}|{stream.duration::time}|{stream.mediaId::hex}|{stream.mediaId::octal}|{stream.mediaId::binary}|{stream.mediaId::string}",
      ),
    ).toEqual(["54 GB|54GB|54 GB|48.5 Mbps|2h 16m|2a|52|101010|42", "1.2 GB|1.2GB|1.2 GB|48.5 Mbps|2h 16m|2a|52|101010|42"]);
    expect(
      renderBoth(
        "{stream.audioTags::join(' · ')}|{stream.audioTags::slice(1)}|{stream.audioTags::slice(0,1)::join('+')}|{stream.title::replace('The ','')}|{stream.filename::truncate(20)}|{stream.title::join('-')}",
      ),
    ).toEqual(["TrueHD · Atmos|Atmos|TrueHD|Matrix|The.Matrix.1999.216…|The Matrix", "DD+||DD+|the office us|The.Office.US.S02E0…|the office us"]);
    expect(
      renderBoth(
        "{config.addonName} | {addon.name} | {service.name} | {stream.container} | {stream.resolution} | {stream.folderSize::bytes} | {metadata.x} | {debug.y}",
      ),
    ).toEqual(["Archive 3D | Archive 3D | FTP | mkv | 2160p | 54 GB |  |", "Archive 3D | Archive 3D | FTP | mkv | 1080p | 1.2 GB |  |"]);
  });

  it("evaluates conditional operators and comparisons", () => {
    expect(
      renderBoth(
        "{stream.title::exists::and::stream.year::exists[\"both\"||\"not both\"]} {stream.year::exists::or::stream.seasons::exists[\"either\"||\"neither\"]} {stream.year::exists::xor::stream.seasons::exists[\"xor\"||\"nxor\"]}",
      ),
    ).toEqual(["both either xor", "not both either xor"]);
    expect(
      renderBoth(
        "{stream.size::>=1288490188[\"ge\"||\"lt\"]} {stream.size::<=1288490188[\"le\"||\"gt\"]} {stream.size::<2000000000[\"small\"||\"big\"]} {stream.title::$The[\"starts\"||\"no\"]} {stream.title::^us[\"ends\"||\"no\"]} {stream.audioTags::~Atmos[\"atmos\"||\"no\"]} {stream.visualTags::=IMAX[\"imax\"||\"no\"]}",
      ),
    ).toEqual(["ge gt big starts no atmos no", "ge le small no ends no imax"]);
    expect(
      renderBoth(
        "{stream.proxied::istrue[\"proxy\"||\"direct\"]} {stream.library::isfalse[\"remote\"||\"lib\"]} {stream.proxied::isfalse::istrue[\"a\"||\"b\"]} {stream.missing::exists::isfalse[\"missing\"||\"present\"]}",
      ),
    ).toEqual(["proxy remote b missing", "proxy remote b missing"]);
  });

  it("renders nested expressions inside quoted branches with escaped quotes", () => {
    expect(
      renderBoth(
        "{stream.title::exists[\"{stream.year::exists['({stream.year})'||'(no year)']} {stream.seasonEpisode::exists['{stream.seasonEpisode::join(\\\"x\\\")}'||'-']}\"||\"\"]}",
      ),
    ).toEqual(["(1999) -", "(no year) S02xE05"]);
    expect(renderBoth("{stream.title::exists[\"say \\\"{stream.title}\\\" it's {stream.quality}\"||\"\"]}")).toEqual([
      "say \"The Matrix\" it's 2160p",
      "say \"the office us\" it's 1080p",
    ]);
    expect(
      renderBoth(
        "{stream.title::exists[\"a}b]c||d\"||\"e\"]}|{stream.title::exists['x\\'y'||'z']}|{stream.title::exists[\"line1\\nline2\"||\"\"]}",
      ),
    ).toEqual(["a}b]c||d|x'y|line1\nline2", "a}b]c||d|x'y|line1\nline2"]);
    expect(
      renderBoth(
        "{stream.title::exists[\"{stream.year::exists['{stream.quality::exists[\\\\\"deep {stream.encode}\\\\\"||\\\\\"\\\\\"]}'||'']}\"||\"\"]}",
      ),
    ).toEqual(["deep HEVC", DEFAULT_DESCRIPTIONS[1]]);
    expect(renderBoth("{stream.title::exists[{stream.year}||none]}|{stream.missing::exists[yes||no]}|{stream.title::exists[\"one\"]}")).toEqual([
      "1999|no|The Matrix",
      "|no|the office us",
    ]);
  });

  it("handles literal newlines, tools, and removed lines", () => {
    expect(
      renderBoth(
        "head\n{stream.message::~Download[\"{tools.removeLine}\"||\"\"]}middle {stream.title}\n\n   \ntail{tools.newLine}{stream.visualTags::=IMAX[\"imax line {tools.removeLine}\"||\"\"]}last\r\nafter crlf",
      ),
    ).toEqual(["head\nmiddle The Matrix\ntail\nlast\nafter crlf", "head\ntail\nafter crlf"]);
    expect(renderBoth("{stream.title}{tools.removeLine}{tools.newLine}{stream.year}", "name")).toEqual(["1999", "FTP Server 2 - 1080p"]);
  });

  it("normalizes name whitespace and trailing separators", () => {
    expect(renderBoth("{stream.visualTags::join(' | ')} - {stream.encode::lower} -  ", "name")).toEqual(["DV | HDR10 - hevc -", "IMAX - avc -"]);
    expect(renderBoth("  {stream.title}   \t  {stream.year}  -   ", "name")).toEqual(["The Matrix 1999 -", "the office us -"]);
    expect(
      renderBoth(
        "{stream.resolution::exists[\"{stream.resolution::replace('2160p','4K')::replace('1080p','FHD')}\"||\"Source\"]}{stream.threeDType::exists[\" ⧉ {stream.threeDType::upper}\"||\"\"]}{tools.newLine}{stream.serverName::smallcaps} - {service.shortName}",
        "name",
      ),
    ).toEqual(["4K\nꜱᴇʀᴠᴇʀ 2 - FTP", "FHD ⧉ HALF SBS\nꜱᴇʀᴠᴇʀ 2 - FTP"]);
    expect(renderBoth("{stream.3dtype} / {stream.threeDType}", "name")).toEqual(["/", "Half SBS / Half SBS"]);
    expect(renderBoth("{stream.title} -\n", "name")).toEqual(["The Matrix -", "the office us -"]);
    expect(renderBoth("{stream.title}  -{tools.newLine}", "name")).toEqual(["The Matrix", "the office us"]);
    expect(renderBoth("{stream.title} -{stream.year}", "name")).toEqual(["The Matrix -1999", "the office us -"]);
    expect(renderBoth("{stream.title}- ", "name")).toEqual(["The Matrix-", "the office us-"]);
    expect(renderBoth(" - x - \n - ", "name")).toEqual(["- x - \n -", "- x - \n -"]);
    expect(renderBoth(" - x - \n - {tools.newLine}", "name")).toEqual(["- x -", "- x -"]);
    expect(renderBoth("x\n-{tools.newLine}", "name")).toEqual(["x", "x"]);
  });

  it("tolerates whitespace, unknown paths, and unknown modifiers", () => {
    expect(
      renderBoth(
        "{ stream.title :: upper }|{stream.title :: truncate( 5 )}|{unknown.root}|{stream}|{stream.a.b}|{}|{   }|{stream.title::nosuchmodifier}",
      ),
    ).toEqual(["THE MATRIX|The …||||||The Matrix", "THE OFFICE US|the …||||||the office us"]);
  });

  it("keeps unclosed or unbalanced braces literal and keeps parsing", () => {
    expect(renderBoth("Literal { brace and } close {stream.title} end {")).toEqual([
      "Literal  close The Matrix end {",
      "Literal  close the office us end {",
    ]);
    expect(renderBoth("{stream.title::truncate(35} then {stream.year} and {stream.quality}")).toEqual([
      "{stream.title::truncate(35} then 1999 and 2160p",
      "{stream.title::truncate(35} then  and 1080p",
    ]);
    expect(renderBoth("{\"unclosed {stream.title} {stream.year}")).toEqual(["{\"unclosed The Matrix 1999", "{\"unclosed the office us"]);
    expect(renderBoth("{{stream.title}}|{{{stream.year}")).toEqual(["}|", "}|"]);
    expect(renderBoth("{(}{stream.year}{)}{stream.quality}")).toEqual(["2160p", "1080p"]);
    expect(renderBoth("{[(]}{stream.year}{)}x{stream.quality}")).toEqual(["x2160p", "x1080p"]);
    expect(renderBoth("{'{'x}{stream.year}")).toEqual(["1999", DEFAULT_DESCRIPTIONS[1]]);
    expect(renderBoth("{stream.title::exists[\"a\\")).toEqual(["{stream.title::exists[\"a\\", "{stream.title::exists[\"a\\"]);
    expect(renderBoth("{stream.title}\\")).toEqual(["The Matrix\\", "the office us\\"]);
  });

  it("falls back to the default template when a template renders empty", () => {
    expect(renderBoth("{[{stream.title}] {stream.year}")).toEqual(DEFAULT_DESCRIPTIONS);
    expect(renderBoth("{[{}]{stream.year}")).toEqual(DEFAULT_DESCRIPTIONS);
    expect(renderBoth("{stream.missing}")).toEqual(DEFAULT_DESCRIPTIONS);
    expect(renderBoth("   ")).toEqual(DEFAULT_DESCRIPTIONS);
    expect(renderBoth("", "name")).toEqual(["FTP Server 2 - 2160p", "FTP Server 2 - 1080p"]);
  });

  it("renders the same template correctly across alternating contexts", () => {
    for (let round = 0; round < 3; round += 1) {
      expect(renderBoth(PRODUCTION_DESCRIPTION)).toEqual(["✎  The Matrix (1999)\n▣  HEVC  54GB", "✎  The Office Us  S02·ᴇ05"]);
    }
  });
});

describe("stream formatter limits", () => {
  it("caps saved templates at 12,000 characters", () => {
    expect(MAX_STREAM_FORMATTER_TEMPLATE_LENGTH).toBe(12_000);
  });

  it("renders templates up to the cap and falls back to the default beyond it", () => {
    const expression = "{stream.title}";
    const atCap = `${"x".repeat(MAX_STREAM_FORMATTER_TEMPLATE_LENGTH - expression.length - 1)} ${expression}`;
    const overCap = `x${atCap}`;

    expect(atCap).toHaveLength(MAX_STREAM_FORMATTER_TEMPLATE_LENGTH);
    expect(renderStreamTemplate(`  ${atCap}\n`, movie, "description").endsWith(" The Matrix")).toBe(true);
    expect(renderBoth(overCap)).toEqual(DEFAULT_DESCRIPTIONS);
  });

  it("treats a dangling conditional operator as a false clause instead of throwing", () => {
    expect(renderBoth("{stream.title::and[\"a\"||\"b\"]}|{stream.title::or[\"c\"||\"d\"]}|{stream.missing::xor[\"e\"||\"f\"]}")).toEqual([
      "b|c|f",
      "b|c|f",
    ]);
  });
});
