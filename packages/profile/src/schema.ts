import { z } from "zod";
import { UserError } from "./errors";
import { JAR_FILENAME } from "./jarcheck";

export const SIDES = ["server", "both", "client-optional"] as const;
export type Side = (typeof SIDES)[number];

const slug = z.string().regex(/^[a-z0-9._-]+$/, 'must be a Modrinth slug like "lithium"');
const memorySize = z.string().regex(/^\d+[MG]$/, 'must look like "2G" or "512M"');
const packId = z.string().regex(/^[a-z0-9]+:[a-z0-9-]+$/, 'must look like "vt:afk-display"');

export const JAR_SIDES = ["server", "both"] as const;
export type JarSide = (typeof JAR_SIDES)[number];

const ModrinthEntrySchema = z.strictObject({
  modrinth: slug,
  side: z.enum(SIDES),
  clientOptional: z.boolean().optional(),
  version: z.string().min(1).optional(),
});

const JarEntrySchema = z.strictObject({
  jar: z.string().regex(/^[a-z0-9._-]+$/, 'must be lowercase letters, digits, ".", "_" and "-"'),
  filename: z.string().regex(JAR_FILENAME, 'must be a file name ending in ".jar", like "mymod-1.0.jar"'),
  sha512: z.string().regex(/^[0-9a-f]{128}$/, "must be the 128-character sha512 that mc-host admin jar add printed"),
  side: z.enum(JAR_SIDES, { error: `must be "server" or "both": players can't opt out of an uploaded jar` }),
});

export type ModrinthEntry = z.infer<typeof ModrinthEntrySchema>;
export type JarEntry = z.infer<typeof JarEntrySchema>;

/**
 * Picks the schema by key, so mistakes are reported against the right fields. A plain
 * z.union would report every mistake as "Invalid input" on the whole entry.
 */
const ModEntrySchema = z.unknown().transform((v, ctx): ModrinthEntry | JarEntry => {
  const schema = v !== null && typeof v === "object" && "jar" in v ? JarEntrySchema : ModrinthEntrySchema;
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  for (const i of r.error.issues) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
  return z.NEVER;
});

export const isJarEntry = (m: ModrinthEntry | JarEntry): m is JarEntry => "jar" in m;
export const isModrinthEntry = (m: ModrinthEntry | JarEntry): m is ModrinthEntry => !isJarEntry(m);
export const modName = (m: ModrinthEntry | JarEntry): string => (isJarEntry(m) ? m.jar : m.modrinth);

export const ProfileSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9-]+$/, "must be lowercase letters, digits and dashes"),
    description: z.string(),
    minecraft: z.string().regex(/^\d+\.\d+(\.\d+)?$/, 'must be a release version like "26.3"'),
    loader: z.strictObject({
      fabric: z.union([z.literal("latest-stable"), z.string().regex(/^\d+\.\d+\.\d+$/)]),
    }),
    memory: z.strictObject({ min: memorySize, max: memorySize }),
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    mods: z.array(ModEntrySchema).min(1),
    waiting: z.array(slug).default([]),
    datapacks: z.array(packId).default([]),
    resourcePack: z.strictObject({ pack: packId, require: z.boolean().default(false) }).optional(),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.mods.forEach((m, i) => {
      const name = modName(m);
      if (seen.has(name)) {
        ctx.addIssue({ code: "custom", path: ["mods", i, isJarEntry(m) ? "jar" : "modrinth"], message: `"${name}" is listed twice` });
      }
      seen.add(name);
      if (isModrinthEntry(m) && m.clientOptional !== undefined && m.side !== "both") {
        ctx.addIssue({ code: "custom", path: ["mods", i, "clientOptional"], message: 'only works with side "both"' });
      }
    });
    p.waiting.forEach((w, i) => {
      if (seen.has(w)) {
        ctx.addIssue({ code: "custom", path: ["waiting", i], message: `"${w}" is in both "mods" and "waiting"` });
      }
    });
    if (toMegabytes(p.memory.min) > toMegabytes(p.memory.max)) {
      ctx.addIssue({ code: "custom", path: ["memory", "min"], message: "is larger than memory.max" });
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;
export type ModEntry = Profile["mods"][number];

export function toMegabytes(size: string): number {
  const n = Number.parseInt(size, 10);
  return size.endsWith("G") ? n * 1024 : n;
}

export function parseProfile(data: unknown, source: string): Profile {
  const result = ProfileSchema.safeParse(data);
  if (result.success) return result.data;
  const lines = result.error.issues.map(
    (i) => `  ${i.path.length ? i.path.join(".") : "(top level)"}: ${i.message}`,
  );
  throw new UserError(`${source} has problems:\n${lines.join("\n")}`);
}
