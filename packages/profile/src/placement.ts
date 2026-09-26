import type { MrProject } from "./modrinth";
import type { Side } from "./schema";

export type ClientNeed = "no" | "optional" | "required";

/** Where a file goes: on the server or not, and how much the client needs it. */
export interface Placement {
  server: boolean;
  client: ClientNeed;
}

const RANK: Record<ClientNeed, number> = { no: 0, optional: 1, required: 2 };

export function placementOf(side: Side, clientOptional = false): Placement {
  switch (side) {
    case "server":
      return { server: true, client: "no" };
    case "both":
      return { server: true, client: clientOptional ? "optional" : "required" };
    case "client-optional":
      return { server: false, client: "optional" };
  }
}

/** The widest of two placements: on the server if either needs it, and the stronger client need. */
export function mergePlacement(a: Placement, b: Placement): Placement {
  return { server: a.server || b.server, client: RANK[a.client] >= RANK[b.client] ? a.client : b.client };
}

export function samePlacement(a: Placement, b: Placement): boolean {
  return a.server === b.server && a.client === b.client;
}

/** Never place a file on a side its Modrinth metadata says it doesn't support. */
export function clampToProject(p: Placement, project: MrProject): Placement {
  return {
    server: p.server && project.server_side !== "unsupported",
    client: project.client_side === "unsupported" ? "no" : p.client,
  };
}

export function sideOf(p: Placement): { side: Side; clientOptional: boolean } {
  // clientOptional means "players may untick it". A client-only library that a both mod
  // requires stays client-optional (not on the server) but is required on the client.
  if (!p.server) return { side: "client-optional", clientOptional: p.client !== "required" };
  if (p.client === "no") return { side: "server", clientOptional: false };
  return { side: "both", clientOptional: p.client === "optional" };
}

/** Best guess of a side for a mod added from "waiting", from its Modrinth metadata. */
export function sideFromMetadata(project: MrProject): Side {
  if (project.server_side === "unsupported") return "client-optional";
  if (project.client_side === "required") return "both";
  return "server";
}
