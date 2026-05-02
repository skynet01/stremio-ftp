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

  it("parses 2x05 episode filenames", () => {
    expect(parseMediaPath("/TV/Show Name/Show Name - 2x05 - Episode Title.mp4")).toMatchObject({
      mediaKind: "series",
      parsedTitle: "show name",
      season: 2,
      episode: 5,
      extension: "mp4",
    });
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

  it("ignores unsupported files", () => {
    expect(parseMediaPath("/TV/Show/notes.txt")).toBeNull();
  });
});
