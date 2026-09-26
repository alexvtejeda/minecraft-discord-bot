import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { unzipSync } from "fflate";

/** What a datapack zip contains, for blaming it from log lines. */
export interface PackIndex {
  file: string;
  /** File entries, sorted. */
  paths: string[];
  /** Every .json/.mcfunction/.mcmeta file, joined and lower-cased. */
  text: string;
}

const TEXT = /\.(json|mcfunction|mcmeta)$/i;

export async function indexPack(packsDir: string, file: string): Promise<PackIndex> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await readFile(join(packsDir, file))));
  } catch (err) {
    throw new UserError(`${file} isn't a readable zip (${(err as Error).message}).`);
  }
  const paths = Object.keys(entries).filter((p) => !p.endsWith("/")).sort();
  const decoder = new TextDecoder();
  const text = paths
    .filter((p) => TEXT.test(p))
    .map((p) => decoder.decode(entries[p]))
    .join("\n")
    .toLowerCase();
  return { file, paths, text };
}

function split(id: string): [string, string] {
  const i = id.indexOf(":");
  return [id.slice(0, i), id.slice(i + 1)];
}

/** The pack has data/<namespace>/<any type folders>/<path>.<ext>. */
export function provides(pack: PackIndex, id: string): boolean {
  const [ns, path] = split(id.toLowerCase());
  const prefix = `data/${ns}/`;
  return pack.paths.some((p) => p.toLowerCase().startsWith(prefix) && p.toLowerCase().replace(/\.[^./]+$/, "").endsWith(`/${path}`));
}

/** The pack's files mention the id. minecraft: ids are in every pack, so they never count. */
export function mentions(pack: PackIndex, id: string): boolean {
  const lower = id.toLowerCase();
  return !lower.startsWith("minecraft:") && pack.text.includes(lower);
}
