import { expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { isTailnetIPv4, tailnetAddress } from "../src/host/address";

const v4 = (address: string) => ({ address, family: "IPv4", internal: false }) as NetworkInterfaceInfo;

test("recognises the tailnet range 100.64.0.0/10", () => {
  expect(isTailnetIPv4("100.64.0.1")).toBe(true);
  expect(isTailnetIPv4("100.127.255.254")).toBe(true);
  expect(isTailnetIPv4("100.128.0.1")).toBe(false);
  expect(isTailnetIPv4("192.168.1.2")).toBe(false);
});

test("prefers a tailscale-named interface", () => {
  expect(tailnetAddress({ eth0: [v4("100.70.0.9")], tailscale0: [v4("100.101.2.3")] })).toBe("100.101.2.3");
  expect(tailnetAddress({ Tailscale: [v4("100.90.0.1")] })).toBe("100.90.0.1");
});

test("falls back to any tailnet IPv4 and explains when there is none", () => {
  expect(tailnetAddress({ eth0: [v4("192.168.1.2"), v4("100.70.0.9")] })).toBe("100.70.0.9");
  expect(() => tailnetAddress({ eth0: [v4("192.168.1.2")] })).toThrow("isn't connected to the Minecraft tailnet");
});
