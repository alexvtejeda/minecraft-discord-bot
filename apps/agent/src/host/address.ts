import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { UserError } from "@mc/profile";

export function isTailnetIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/**
 * This PC's address on the Minecraft tailnet. In Docker the agent shares the Tailscale sidecar's
 * network namespace, so tailscale0 is visible here; on Windows the Tailscale adapter is too.
 */
export function tailnetAddress(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string {
  const found = Object.entries(ifaces).flatMap(([name, list]) =>
    (list ?? [])
      .filter((a) => (a.family === "IPv4" || (a.family as unknown) === 4) && isTailnetIPv4(a.address))
      .map((a) => ({ name, ip: a.address })),
  );
  const tailscaleFirst = (n: string) => (/tailscale/i.test(n) ? 0 : 1);
  found.sort((x, y) => tailscaleFirst(x.name) - tailscaleFirst(y.name));
  if (!found[0]) {
    throw new UserError("This PC isn't connected to the Minecraft tailnet. Open Tailscale, make sure it's connected, and try again.");
  }
  return found[0].ip;
}
