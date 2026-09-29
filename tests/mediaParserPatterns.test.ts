import { describe, expect, it } from "vitest";
import { normalizeTitle } from "../src/server/media/normalizer";
import { parseMediaPath, type ParseMediaOptions } from "../src/server/media/parser";

// Fixtures below are real path shapes taken from production indexes where the
// previous parser produced an unmatched or wrong catalog item.
const folders: ParseMediaOptions = { contentTypes: { movies: true, series: true, anime: true }, libraryLayout: "folders" };
const auto: ParseMediaOptions = { contentTypes: { movies: true, series: true, anime: true }, libraryLayout: "auto" };

describe("resolution numbers are never release years", () => {
  it.each([
    ["/Blockbuster Movies/Avatar - Fire and Ash (2025)/Avatar - Fire and Ash FS3D 1920x1080.mkv", "avatar fire and ash", 2025],
    ["/VR Videos (180-360 Degree)/Ancient city Petra Jordan (2023)/Ancient_city_Petra_Jordan_2048p_4k_hevc.mkv", "ancient city petra jordan", 2023],
    ["/VR Videos (180-360 Degree)/Bryce Canyon USA (2021)/Bryce_Canyon_USA_Part_II_1920p50_4k_hevc.mkv", "bryce canyon usa", 2021],
    ["/VR Videos (180-360 Degree)/Bern Switzerland 2048p (2017)/Bern_Switzerland_4_2048p_4k_hevc.mkv", "bern switzerland", 2017],
    ["/Blockbuster Movies/Purple Rain (1984)/Purple.Rain.1984.1080p.BluRay.x264_FullSBS_1904x1072.mp4", "purple rain", 1984],
  ])("%s", (path, title, year) => {
    expect(parseMediaPath(path, folders)).toMatchObject({ mediaKind: "movie", parsedTitle: title, parsedYear: year });
  });

  it("does not read a year out of NNNNxNNNN, NNNNp or NNNNpNN tokens without folder context", () => {
    expect(parseMediaPath("/Movies/Avatar - Fire and Ash FS3D 1920x1080.mkv", auto)).toMatchObject({ parsedTitle: "avatar fire and ash", parsedYear: null });
    expect(parseMediaPath("/Movies/Angel_Falls_Venezuela_8K_3840p_8k_hevc.mkv", auto)).toMatchObject({ parsedYear: null });
    expect(parseMediaPath("/Movies/Canyon_Flight_1920p50_4k_hevc.mkv", auto)).toMatchObject({ parsedTitle: "canyon flight", parsedYear: null });
    expect(parseMediaPath("/Movies/Petra_2048p_2023_4k_hevc.mkv", auto)).toMatchObject({ parsedTitle: "petra", parsedYear: 2023 });
  });

  it("ignores numbers past next year as release years", () => {
    expect(parseMediaPath("/Anime/Bubblegum Crisis Tokyo 2040 - S01E16 - I Surrender.mkv", auto)).toMatchObject({
      parsedTitle: "bubblegum crisis tokyo 2040",
      parsedYear: null,
    });
  });
});

describe("folder year versus filename year", () => {
  it("keeps the filename year and records the conflicting folder year as the alternate", () => {
    expect(parseMediaPath("/Blockbuster Movies/Reefer Madness (1938)/Reefer Madness 1936.mp4", folders)).toMatchObject({
      parsedTitle: "reefer madness",
      parsedYear: 1936,
      alternateTitle: "reefer madness",
      alternateYear: 1938,
    });
    expect(
      parseMediaPath("/Superhero Movies/Hellboy II - The Golden Army (2008)/Hellboy 2 Les Légions D'or Maudites [2006] [3D 1080p FSBS] x264.mkv", folders),
    ).toMatchObject({
      parsedTitle: "hellboy ii golden army",
      parsedYear: 2006,
      alternateTitle: "hellboy ii golden army",
      alternateYear: 2008,
    });
  });

  it("records the filename-derived title as the alternate when it differs from the folder title", () => {
    expect(parseMediaPath("/JFC/Novacaine (2025) -JFC/Novocaine.3D_2025.Full-SBS.x.ENG.AC3.JFC_3DHDCLUB_4k_hevc.mkv", folders)).toMatchObject({
      parsedTitle: "novacaine",
      parsedYear: 2025,
      alternateTitle: "novocaine",
      alternateYear: 2025,
    });
  });

  it("has no alternate when folder and filename agree", () => {
    expect(parseMediaPath("/Blockbuster Movies/The Matrix (1999)/The.Matrix.1999.1080p.mkv", folders)).toMatchObject({
      parsedTitle: "matrix",
      parsedYear: 1999,
      alternateTitle: null,
      alternateYear: null,
    });
  });
});

describe("episode formats", () => {
  it.each([
    ["/Anime Shows/Haikyu (2014)/Haikyuu.S1.01_3DFF_FSBS.mkv", "haikyu", 1, 1],
    ["/Anime Shows/Haikyu (2014)/Haikyuu.S4.25_3DFF_FSBS.mkv", "haikyu", 4, 25],
    ["/Anime Shows/Blue Lock (2022)/Blue Lock S1.01_3DFF_FSBS.mkv", "blue lock", 1, 1],
    ["/Anime Shows/Sekirei (2008)/Sekirei.S2.01_3DFF_FSBS.mkv", "sekirei", 2, 1],
    ["/Anime Shows/Hells Paradise - Jigokuraku (2023)/Hells Paradise - JigokurakuS1.01.H264.FSBS.3DFF.mkv", "hells paradise jigokuraku", 1, 1],
    ["/Anime Shows/Utawarerumono (2006)/Utawarerumono - (Ep. 01) - Something Uninvited.3D.FSBS.convert.mkv", "utawarerumono", 1, 1],
    ["/Anime Shows/Serial Experiments Lain (1998)/Serial Experiments Lain - (Ep. 13) - Ego [3D FSBS].mkv", "serial experiments lain", 1, 13],
    ["/Anime Shows/Divergence Eve (2003)/Divergence Eve.E01_3DFF_FSBS.mkv", "divergence eve", 1, 1],
  ])("parses %s as an anime episode", (path, title, season, episode) => {
    expect(parseMediaPath(path, folders)).toMatchObject({ mediaKind: "series", catalogKind: "anime", parsedTitle: title, season, episode });
  });

  it("parses glued SxEy markers and takes the series title from the folder", () => {
    expect(parseMediaPath("/TV Shows/The Mandalorian (2019)/MandoS1E1.1080p.FullSBS.Atmos.mkv", folders)).toMatchObject({
      mediaKind: "series",
      catalogKind: "series",
      parsedTitle: "mandalorian",
      season: 1,
      episode: 1,
    });
    expect(parseMediaPath("/TV/Hells Paradise - JigokurakuS1.02.H264.mkv", auto)).toMatchObject({
      mediaKind: "series",
      parsedTitle: "hells paradise jigokuraku",
      season: 1,
      episode: 2,
    });
  });

  it("parses NNeNN markers and expands an abbreviated filename title from its folder", () => {
    expect(parseMediaPath("/TV Shows/American Horror Story (2011)/AHS.01E04_3DFF_FSBS.mkv", auto)).toMatchObject({
      mediaKind: "series",
      catalogKind: "series",
      parsedTitle: "american horror story",
      season: 1,
      episode: 4,
    });
  });

  it("keeps a non-abbreviated filename title in auto layout", () => {
    expect(parseMediaPath("/TV Shows/Downloads/Dark.S01E01.1080p.mkv", auto)).toMatchObject({ parsedTitle: "dark", season: 1, episode: 1 });
  });

  it("parses three-digit absolute anime episodes", () => {
    expect(parseMediaPath("/Anime Shows/Naruto Shippuden - Canon (2007)/Naruto Shippuuden.206.H264.FSBS.3DFF.mkv", folders)).toMatchObject({
      mediaKind: "series",
      catalogKind: "anime",
      season: 1,
      episode: 206,
    });
  });

  it("uses the first episode of a multi-episode file", () => {
    expect(parseMediaPath("/TV Shows/Æon Flux (1991)/Aeon Flux S01E01-06 NA_3D_jesterko_FSBS_x265.mkv", folders)).toMatchObject({
      mediaKind: "series",
      parsedTitle: "aeon flux",
      season: 1,
      episode: 1,
    });
  });

  it("drops a leading sort index before the series title", () => {
    expect(
      parseMediaPath(
        "/TV Shows/Star Wars - The Clone Wars (2008)/E001_Star Wars_ The Clone Wars_S02E16_Cat and Mouse_30_8_RIGHT_ONLY_00_v1.8.6_halfSBS.mp4",
        auto,
      ),
    ).toMatchObject({ mediaKind: "series", parsedTitle: "star wars clone wars", season: 2, episode: 16 });
  });

  it("does not treat an episode-number title word in a clear movie folder as an episode", () => {
    expect(
      parseMediaPath(
        "/Blockbuster Movies/Star Wars - Return of the Jedi (1983)/Star.Wars.Ep6-Return.of.the.Jedi.(1983).3D.HSBS.BluRay.H.DolbyD.5.1.+.nickarad_1080p_hevc.mkv",
        folders,
      ),
    ).toMatchObject({ mediaKind: "movie", parsedTitle: "star wars return of jedi", parsedYear: 1983 });
  });
});

describe("series title cleaning", () => {
  it("moves a parenthesized or dotted year out of the series title", () => {
    expect(
      parseMediaPath("/TV Shows/Loki (2021)/Loki (2021) - S01E01 - Glorious Purpose (1080p DSNP WEB-DL x265 Silence)_3DFF_FSBS.mkv", auto),
    ).toMatchObject({ parsedTitle: "loki", parsedYear: 2021, season: 1, episode: 1 });
    expect(
      parseMediaPath("/TV Shows/Stranger Things (2016)/Stranger.Things.2016.S05E02.Chapitre.deux.MULTi.1080p.WEB.DDP.5.1.Atmos.AV1-BTT.mkv", auto),
    ).toMatchObject({ parsedTitle: "stranger things", parsedYear: 2016, season: 5, episode: 2 });
  });

  it("uses the folder year for a folder-layout series only when the filename carries a year", () => {
    expect(parseMediaPath("/TV Shows/Invincible (2021)/Invincible.2021.S01E08.FiNAL.MULTi.1080p.WEB.H265-FW.mkv", folders)).toMatchObject({
      parsedTitle: "invincible",
      parsedYear: 2021,
    });
    expect(parseMediaPath("/TV Shows/Vikings (2013)/Vikings.S01E01.1080p.mkv", folders)).toMatchObject({
      parsedTitle: "vikings",
      parsedYear: null,
    });
    expect(parseMediaPath("/TV Shows/Space 1999 (1975)/Space.1999.S01E01.mkv", folders)).toMatchObject({
      parsedTitle: "space 1999",
      parsedYear: 1975,
    });
  });

  it("drops bracket tags from series titles", () => {
    expect(
      parseMediaPath("/TV Shows/HAPPY! (2017)/Happy! [TV Series]_S01E02_ What Smiles Are For_35_8_RIGHT_ONLY_00_v1.8.6_halfSBS.mp4", auto),
    ).toMatchObject({ parsedTitle: "happy", season: 1, episode: 2 });
  });

  it("collapses dotted acronyms", () => {
    expect(parseMediaPath("/TV Shows/Agents of S.H.I.E.L.D. (2013)/Agents of S.H.I.E.L.D. S02E03_3DFF_FSBS.mkv", auto)).toMatchObject({
      parsedTitle: "agents of shield",
      season: 2,
      episode: 3,
    });
    expect(parseMediaPath("/Movies/E.T.the.Extra-Terrestrial.1982.1080p.mkv", auto)).toMatchObject({
      parsedTitle: "et extra terrestrial",
      parsedYear: 1982,
    });
  });
});

describe("normalizeTitle", () => {
  it("transliterates and strips diacritics instead of dropping letters", () => {
    expect(normalizeTitle("Æon Flux")).toBe("aeon flux");
    expect(normalizeTitle("Shōgun")).toBe("shogun");
    expect(normalizeTitle("Amélie")).toBe("amelie");
    expect(normalizeTitle("Øresund")).toBe("oresund");
    expect(normalizeTitle("Die Straße")).toBe("die strasse");
    expect(normalizeTitle("Naruto Shippūden")).toBe("naruto shippuden");
  });

  it("collapses dotted acronyms without gluing the next word", () => {
    expect(normalizeTitle("Marvel's Agents of S.H.I.E.L.D.")).toBe("marvels agents of shield");
    expect(normalizeTitle("A.I. Artificial Intelligence")).toBe("ai artificial intelligence");
    expect(normalizeTitle("A.I.Artificial.Intelligence")).toBe("ai artificial intelligence");
    expect(normalizeTitle("L.A. Confidential")).toBe("la confidential");
    expect(normalizeTitle("The.A.Team")).toBe("a team");
  });
});

describe("content without a catalog identity stays a plain movie", () => {
  it("does not invent series structure for VR and drone clips", () => {
    expect(
      parseMediaPath("/VR Videos (180-360 Degree)/Dunkirk - 360 Degree VR Experience (2018)/Dunkirk_VR_Experience_Find_Yourself_On_The_Shores_hevc.mkv", folders),
    ).toMatchObject({ mediaKind: "movie", catalogKind: "movie", parsedYear: 2018 });
  });
});
