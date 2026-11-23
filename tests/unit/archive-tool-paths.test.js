"use strict";

/**
 * Unit tests for the configured archive tool binaries.
 *
 * The RAR and 7z helpers used to spawn a hard-coded /usr/bin/... path, which
 * can only exist on a Linux host. They now read `unrar` and `sevenzip` from
 * configuration, so these tests pin that contract: the configured path is the
 * binary that runs, and an unset key falls back to the plain command name.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const RAR5_MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

const RAR_LISTING = [
  "",
  "UNRAR 7.30 beta 2 x64 freeware      Copyright (c) 1993-2026 Alexander Roshal",
  "",
  "Archive: sample.rar",
  "Details: RAR 5",
  "",
  " Attributes       Size     Date    Time   Name",
  "----------- ----------  ---------- -----  ----",
  " -rwxr-xr-x    1800706  2026-11-23 14:42  cover.png",
  " -rwxr-xr-x     442769  2026-11-23 14:42  pages\\page1.png",
  " drwxr-xr-x          0  2026-11-23 14:42  emptydir",
  "----------- ----------  ---------- -----  ----",
  "               2243475                    3",
  "",
].join("\n");

const RAR_LISTING_LEGACY = [
  "UNRAR 5.60 freeware      Copyright (c) 1993-2018 Alexander Roshal",
  "",
  "Archive: sample.rar",
  "",
  " Attributes      Size     Packed Ratio   Date   Time   Checksum  Name",
  "----------- ---------  --------- -----  ------ -----  --------  ----",
  " .....           1024        512   50%  2026-11-23 13:00 ABCDEF12  cover.png",
  " F....              0          0    0%  2026-11-23 13:00 00000000  pages/",
  "----------- ---------  --------- -----  ------ -----  --------  ----",
  "                 1024        512   50%",
  "",
].join("\n");

const SEVENZ_LISTING = [
  "7-Zip 24.09 (x64)",
  "",
  "Listing archive: sample.7z",
  "",
  "   Date      Time    Attr         Size   Compressed  Name",
  "------------------- ----- ------------ ------------  ------------------------",
  "2026-11-23 13:00:00 ....A         2048         1024  page.jpg",
  "------------------- ----- ------------ ------------  ------------------------",
].join("\n");

let workDir;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hobbyfiles-archive-tools-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeArchive(name, magic) {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, Buffer.from(magic));
  return file;
}

/**
 * Load lib/archive with a stubbed config and a stubbed spawn that records the
 * argv it was handed.
 *
 * @param {object} values - configuration values; a missing key resolves false
 * @param {string} listing - stdout the fake tool returns
 * @returns {{listArchive: Function, spawns: string[][]}}
 */
function loadArchive(values, listing) {
  jest.resetModules();
  const spawns = [];
  jest.doMock("../../lib/config", () => ({
    get: key => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : false),
  }));
  jest.doMock("../../lib/media/jail", () => ({
    spawnBounded: jest.fn(argv => {
      spawns.push(argv);
      return Promise.resolve({
        code: 0,
        stdout: Buffer.from(listing),
        stderr: "",
        truncated: false,
        timedOut: false,
      });
    }),
  }));
  return { listArchive: require("../../lib/archive").listArchive, spawns };
}

describe("configured archive tool paths", () => {
  afterEach(() => {
    jest.dontMock("../../lib/config");
    jest.dontMock("../../lib/media/jail");
  });

  test("a RAR listing runs the configured unrar binary", async () => {
    const file = writeArchive("sample.rar", RAR5_MAGIC);
    const { listArchive, spawns } = loadArchive(
      { unrar: "/opt/tools/bin/unrar", sevenzip: "/opt/tools/bin/7z", maxAssetsProcesses: 2 },
      RAR_LISTING,
    );

    const result = await listArchive(file, "sample.rar");

    expect(spawns).toHaveLength(1);
    expect(spawns[0][0]).toBe("/opt/tools/bin/unrar");
    expect(spawns[0].slice(1)).toEqual(["l", "-p-", file]);
    expect(result.format).toBe("rar");
  });

  test("the unrar 7 listing reports sizes, separators and directories", async () => {
    const file = writeArchive("sizes.rar", RAR5_MAGIC);
    const { listArchive } = loadArchive({ unrar: "unrar", maxAssetsProcesses: 2 }, RAR_LISTING);

    const { files } = await listArchive(file, "sizes.rar");

    expect(files).toEqual([
      { path: "cover.png", size: 1800706, isDir: false },
      { path: "pages/page1.png", size: 442769, isDir: false },
      { path: "emptydir", size: 0, isDir: true },
    ]);
  });

  test("the older listing with packed, ratio and checksum columns still parses", async () => {
    const file = writeArchive("legacy.rar", RAR5_MAGIC);
    const { listArchive } = loadArchive({ unrar: "unrar", maxAssetsProcesses: 2 }, RAR_LISTING_LEGACY);

    const { files } = await listArchive(file, "legacy.rar");

    expect(files).toEqual([
      { path: "cover.png", size: 1024, isDir: false },
      { path: "pages/", size: 0, isDir: true },
    ]);
  });

  test("a 7z listing runs the configured sevenzip binary", async () => {
    const file = writeArchive("sample.7z", SEVENZ_MAGIC);
    const { listArchive, spawns } = loadArchive(
      { unrar: "/opt/tools/bin/unrar", sevenzip: "/opt/tools/bin/7z", maxAssetsProcesses: 2 },
      SEVENZ_LISTING,
    );

    const result = await listArchive(file, "sample.7z");

    expect(spawns).toHaveLength(1);
    expect(spawns[0][0]).toBe("/opt/tools/bin/7z");
    expect(spawns[0].slice(1)).toEqual(["l", file]);
    expect(result.format).toBe("7z");
    expect(result.files.map(entry => entry.path)).toEqual(["page.jpg"]);
  });

  test("an unset key falls back to the command name on PATH", async () => {
    const file = writeArchive("fallback.rar", RAR5_MAGIC);
    const { listArchive, spawns } = loadArchive({ maxAssetsProcesses: 2 }, RAR_LISTING);

    await listArchive(file, "fallback.rar");

    expect(spawns[0][0]).toBe("unrar");
  });

  test("an extension-less upload is passed to unrar with a trailing dot", async () => {
    // Stored uploads are named by their key and carry no extension. unrar
    // appends ".rar" to such a name, so the listing silently came back empty
    // until the operand was given a trailing dot.
    const file = writeArchive("x35Md3mw5_tIA5KuRkLu", RAR5_MAGIC);
    const { listArchive, spawns } = loadArchive({ unrar: "unrar", maxAssetsProcesses: 2 }, RAR_LISTING);

    const { files } = await listArchive(file, "sample.rar");

    expect(spawns[0][3]).toBe(`${file}.`);
    expect(files.map(entry => entry.path)).toEqual(["cover.png", "pages/page1.png", "emptydir"]);
  });

  test("an extraction uses the same operand form and host separators", async () => {
    const file = writeArchive("extract-key", RAR5_MAGIC);
    const { spawns } = loadArchive({ unrar: "unrar", maxAssetsProcesses: 2 }, RAR_LISTING);

    const archive = require("../../lib/archive");

    await archive.extractEntry(file, "sample.rar", "cover.png");
    await archive.extractEntry(file, "sample.rar", "pages/page1.png");

    const [flat, nested] = spawns.filter(call => call[1] === "p");
    expect(flat[4]).toBe(`${file}.`);
    expect(flat[5]).toBe("cover.png");

    // unrar matches masks with the host separator: a Windows build needs
    // "pages\\page1.png" for an entry the listing reports as "pages/page1.png".
    expect(nested[5]).toBe(`pages${path.sep}page1.png`);
  });
});
