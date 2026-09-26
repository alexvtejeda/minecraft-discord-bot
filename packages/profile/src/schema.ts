import { z } from "zod";
import { UserError } from "./errors";

export const SIDES = ["server", "both", "client-optional"] as const;
export type Side = (typeof SIDES)[number];

const slug = z.string().regex(/^[a-z0-9._-]+$/, 'must be a Modrinth slug like "lithium"');
const memorySize = z.string().regex(/^\d+[MG]$/, 'must look like "2G" or "512M"');
const packId = z.string().regex(/^[a-z0-9]+:[a-z0-9-]+$/, 'must look like "vt:afk-display"');

const ModEntrySchema = z.strictObject({
  modrinth: slug,
  side: z.enum(SIDES),
  clientOptional: z.boolean().optional(),
  version: z.string().min(1).optional(),
});

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
      if (seen.has(m.modrinth)) {
        ctx.addIssue({ code: "custom", path: ["mods", i, "modrinth"], message: `"${m.modrinth}" is listed twice` });
      }
      seen.add(m.modrinth);
      if (m.clientOptional !== undefined && m.side !== "both") {
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
