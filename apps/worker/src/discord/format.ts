export function duration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const ago = (ms: number): string => (ms < 60_000 ? "just now" : `${duration(ms)} ago`);

export const mention = (id: string): string => `<@${id}>`;

/** snapshots.uploaded_by: a Discord id, "rollback:<id>", or "admin" for an import. */
export function savedBy(uploadedBy: string): string {
  if (/^\d+$/.test(uploadedBy)) return mention(uploadedBy);
  if (uploadedBy.startsWith("rollback:")) return `a rollback by ${mention(uploadedBy.slice("rollback:".length))}`;
  return "an import";
}

export function size(bytes: number): string {
  const mb = bytes / 1_048_576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
