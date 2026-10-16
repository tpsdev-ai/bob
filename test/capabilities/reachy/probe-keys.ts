import { expect } from "bun:test";

// Network-capable system services the sidecar must not reach (each needs a
// working control: a name this macOS does not register proves nothing).
export const MACH_SERVICES = [
  "com.apple.nsurlsessiond",
  "com.apple.dnssd.service",
  "com.apple.cfnetwork.cfnetworkagent",
  "com.apple.analyticsd",
];

export function assertConfinementProbeKeys(control: object, confined: object): void {
  const expectedKeys = [
    "tcp4",
    "tcp6",
    "udp4",
    "unixOther",
    "mdns",
    ...MACH_SERVICES.map((name) => `mach:${name}`),
    "childTcp4",
    "exec",
    "readOutside",
    "writeOutside",
  ].sort();
  expect(Object.keys(control).sort(), "unconfined probe keys").toEqual(expectedKeys);
  expect(Object.keys(confined).sort(), "confined probe keys").toEqual(expectedKeys);
}
