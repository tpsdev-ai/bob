// #170 follow-up: `mapBobProviderToPi` must be idempotent.
//
// The provider override is mapped exactly once, at the boundary where a bob
// provider name enters (run.ts maps bob.yaml's provider; align/onboard map the
// override). If a caller — by mistake, or a future refactor — mapped the result
// a second time, a name that is ALREADY a pi id (e.g. "anthropic") is a
// pass-through while "exe-dev-gateway" maps to "anthropic", so a double map is
// a no-op ONLY if the function is idempotent. This pins that property so a
// non-idempotent edit is caught.
import { describe, expect, it } from "bun:test";
import { mapBobProviderToPi } from "../../src/shell/run.js";

describe("mapBobProviderToPi — idempotent", () => {
  it("maps exe-dev-gateway to anthropic, and mapping again is a no-op", () => {
    const once = mapBobProviderToPi("exe-dev-gateway");
    const twice = mapBobProviderToPi(once);
    expect(once).toBe("anthropic");
    expect(twice).toBe(once);
  });

  it("a pass-through provider is unchanged by a second mapping", () => {
    // "ollama-cloud" is not bob's gateway alias, so it maps to itself; mapping
    // the result again must still equal the first mapping.
    const name = "ollama-cloud";
    const once = mapBobProviderToPi(name);
    const twice = mapBobProviderToPi(once);
    expect(once).toBe(name);
    expect(twice).toBe(once);
  });
});
