import { expect, test } from "bun:test";
import { cacheDir, configDir, dataDir } from "../src/paths";

test("linux uses XDG dirs with home fallbacks", () => {
  expect(cacheDir({}, "linux", "/home/u")).toBe("/home/u/.cache/mc-host");
  expect(cacheDir({ XDG_CACHE_HOME: "/x" }, "linux", "/home/u")).toBe("/x/mc-host");
  expect(configDir({}, "linux", "/home/u")).toBe("/home/u/.config/mc-host");
});

test("windows uses LOCALAPPDATA and APPDATA with backslashes", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\f\\AppData\\Local", APPDATA: "C:\\Users\\f\\AppData\\Roaming" };
  expect(cacheDir(env, "win32", "C:\\Users\\f")).toBe("C:\\Users\\f\\AppData\\Local\\mc-host\\cache");
  expect(configDir(env, "win32", "C:\\Users\\f")).toBe("C:\\Users\\f\\AppData\\Roaming\\mc-host");
});

test("dataDir honours MC_DATA_DIR, then the platform default", () => {
  expect(dataDir({ MC_DATA_DIR: "/data" }, "linux", "/home/a")).toBe("/data");
  expect(dataDir({}, "linux", "/home/a")).toBe("/home/a/.local/share/mc-host/data");
  expect(dataDir({ XDG_DATA_HOME: "/x" }, "linux", "/home/a")).toBe("/x/mc-host/data");
  expect(dataDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a")).toBe(
    "C:\\Users\\a\\AppData\\Local\\mc-host\\data",
  );
});
