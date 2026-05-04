import { describe, expect, it } from "vitest";
import { normalizeTitle } from "../src/server/media/normalizer";
import { parseMediaPath } from "../src/server/media/parser";

describe("media parser", () => {
  it("normalizes titles", () => {
    expect(normalizeTitle("The.Last.of.Us")).toBe("last of us");
    expect(normalizeTitle("Marvel's Agents_of_S.H.I.E.L.D")).toBe("marvels agents of shield");
  });

  it("parses SxxEyy episode filenames", () => {
    expect(parseMediaPath("/TV/Show.Name/Season 02/Show.Name.S02E05.1080p.mkv")).toMatchObject({
      mediaKind: "series",
      parsedTitle: "show name",
      season: 2,
      episode: 5,
      quality: "1080p",
      extension: "mkv",
    });
  });

  it("skips invalid zero-numbered SxxEyy episodes", () => {
    expect(parseMediaPath("/TV/Show.Name/Season 01/Show.Name.S01E00.1080p.mkv")).toBeNull();
    expect(parseMediaPath("/TV/Show.Name/Season 00/Show.Name.S00E01.1080p.mkv")).toBeNull();
  });

  it("parses 2x05 episode filenames", () => {
    expect(parseMediaPath("/TV/Show Name/Show Name - 2x05 - Episode Title.mp4")).toMatchObject({
      mediaKind: "series",
      parsedTitle: "show name",
      season: 2,
      episode: 5,
      extension: "mp4",
    });
  });

  it("skips invalid zero-numbered 2x05 episodes", () => {
    expect(parseMediaPath("/TV/Show Name/Show Name - 2x00 - Episode Title.mp4")).toBeNull();
    expect(parseMediaPath("/TV/Show Name/Show Name - 0x05 - Episode Title.mp4")).toBeNull();
  });

  it("parses movie title year and imdb id", () => {
    expect(parseMediaPath("/Movies/The.Matrix.1999.tt0133093.2160p.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "matrix",
      parsedYear: 1999,
      imdbId: "tt0133093",
      quality: "2160p",
    });
  });

  it("prefers the last plausible movie release year", () => {
    expect(parseMediaPath("/Movies/2001.A.Space.Odyssey.1968.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "2001 a space odyssey",
      parsedYear: 1968,
    });
    expect(parseMediaPath("/Movies/Blade.Runner.2049.2017.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "blade runner 2049",
      parsedYear: 2017,
    });
  });

  it("derives SxxEyy episode title from folder context", () => {
    expect(parseMediaPath("/TV/Show.Name/Season 02/S02E05.1080p.mkv")).toMatchObject({
      mediaKind: "series",
      parsedTitle: "show name",
      season: 2,
      episode: 5,
    });
  });

  it("derives 2x05 episode title from folder context", () => {
    expect(parseMediaPath("/TV/Show Name/Season 2/2x05.mkv")).toMatchObject({
      mediaKind: "series",
      parsedTitle: "show name",
      season: 2,
      episode: 5,
    });
  });

  it("strips web dl token variants from movie titles", () => {
    expect(parseMediaPath("/Movies/Movie.WEB.DL.x264.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "movie",
    });
  });

  it("strips 3D format tokens from movie titles", () => {
    expect(parseMediaPath("/Movies/Zack Snyders Justice League_3DFF_FSBS.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "zack snyders justice league",
      parsedYear: null,
    });
  });

  it("parses anime absolute episode numbers when anime content is enabled", () => {
    expect(
      parseMediaPath("/Anime/Afro Samurai/Afro.Samurai.01.1080p.mkv", {
        contentTypes: { movies: true, series: true, anime: true },
      }),
    ).toMatchObject({
      mediaKind: "series",
      catalogKind: "anime",
      parsedTitle: "afro samurai",
      season: 1,
      episode: 1,
      quality: "1080p",
    });
  });

  it("skips invalid zero-numbered anime absolute episodes", () => {
    expect(
      parseMediaPath("/Anime/Afro Samurai/Afro.Samurai.00.1080p.mkv", {
        contentTypes: { movies: false, series: true, anime: true },
      }),
    ).toBeNull();
  });

  it("parses folder-mode anime absolute episodes when file title matches the folder", () => {
    expect(
      parseMediaPath("/Afro Samurai (2007)/Afro Samurai.01_3DFF_FSBS.mkv", {
        contentTypes: { movies: true, series: true, anime: true },
        libraryLayout: "folders",
      }),
    ).toMatchObject({
      mediaKind: "series",
      catalogKind: "anime",
      parsedTitle: "afro samurai",
      season: 1,
      episode: 1,
    });
  });

  it("does not classify 3d movie filenames as anime when anime and movies are both enabled", () => {
    expect(
      parseMediaPath("/3D Movies/Ready Player One 2018/Ready.Player.One.2018.3D.BluRay.Half-SBS.x.DTS-HD.MA.7.1-FGT_1080p_hevc.mkv", {
        contentTypes: { movies: true, series: true, anime: true },
        libraryLayout: "folders",
      }),
    ).toMatchObject({
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "ready player one",
      parsedYear: 2018,
    });
  });

  it("extracts movie title and year from folder names in folder layout", () => {
    expect(
      parseMediaPath("/3D Movies/Avatar 2009/Avatar_REMASTERED_3D-HSBS_1080p_MultiAudio2.mkv", {
        contentTypes: { movies: true, series: true, anime: true },
        libraryLayout: "folders",
      }),
    ).toMatchObject({
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "avatar",
      parsedYear: 2009,
    });
  });

  it("strips VR dimensions and 3D tokens from movie titles", () => {
    expect(parseMediaPath("/3D Movies/VR-SBS_3840x1080_The_Amazing_Spider-Man__2012_.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "amazing spider man",
      parsedYear: 2012,
    });
    expect(parseMediaPath("/3D Movies/VR-SBS_3840x1080_WD_s_Toy_Story_2_1999.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "toy story 2",
      parsedYear: 1999,
    });
  });

  it("parses movie titles when the filename starts with the release year", () => {
    expect(parseMediaPath("/3D Movies/2000.Scary.Movie.DECKER_Full_SBS.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "scary movie",
      parsedYear: 2000,
    });
  });

  it("handles mixed-case SxxEyy episode filenames", () => {
    expect(parseMediaPath("/TV/Ash Vs Evil Dead/Ash Vs Evil Dead S03e04.mkv")).toMatchObject({
      mediaKind: "series",
      parsedTitle: "ash vs evil dead",
      season: 3,
      episode: 4,
    });
  });

  it("uses folder names for folder-layout movies and series episodes", () => {
    expect(
      parseMediaPath("/Movies/The Amazing Spider-Man (2012)/VR-SBS_3840x1080_random_extra_name.mkv", {
        contentTypes: { movies: true, series: true, anime: false },
        libraryLayout: "folders",
      }),
    ).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "amazing spider man",
      parsedYear: 2012,
    });
    expect(
      parseMediaPath("/TV/Ash Vs Evil Dead/Season 03/random.S03E04.mkv", {
        contentTypes: { movies: true, series: true, anime: false },
        libraryLayout: "folders",
      }),
    ).toMatchObject({
      mediaKind: "series",
      parsedTitle: "ash vs evil dead",
      season: 3,
      episode: 4,
    });
  });

  it("ignores unsupported files", () => {
    expect(parseMediaPath("/TV/Show/notes.txt")).toBeNull();
  });
});
