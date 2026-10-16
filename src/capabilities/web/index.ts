// Bob capability: web — a pi extension (bob#152, spec v3, slices R1a–R1c).
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => void`. The extension validates the resolved config
// block Bob hands it in BOB_CAP_WEB, against the same schema the catalog
// validated bob.yaml with, and REGISTERS THE `web_fetch` TOOL. The fetch core
// (address policy, redirects, limits, extraction) is slice R1b (fetch.ts); URL
// provenance and the admission budgets are slice R1c (provenance.ts,
// admission.ts, tool.ts).
//
// ADMISSION. The tool's provenance and budgets belong to one ADMITTED
// OPERATION: the runtime turn admission the prompt runs inside, including its
// automatic continuations. The extension seeds a fresh state on the operation's
// first `before_agent_start` (the event after prompt expansion and before the
// agent loop) and keeps it, unchanged, for the operation's later prompts; a
// prompt outside any admission (a bare prompt that the runtime did not route
// through one) seeds nothing and `web_fetch` is refused. Session close drops
// the state.
//
// A session that holds this capability (or allows an egress tool) is a WEB
// session. bob refuses to compose one with anything private beyond its admitted
// prompt (data-class.ts): at YAML load over the capability set, in the session
// factory before pi's runtime is built, and on the composed session at
// creation, after the mode binds extensions and after every reload. A web
// session sends bob's reviewed system prompt in place of pi's template and has
// no agent workspace (pi's working directory is "/").

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTurnAdmission } from "../../shell/turn-admission.js";
import { type WebPiLike, wireWebCapability } from "./capability.js";
import { loadConfigFromEnv } from "./config.js";
import { resolveWebSettings } from "./core.js";

export default function (pi: ExtensionAPI): void {
  // A bad block fails the extension load, which bob turns into a named
  // session refusal (session.ts assertCapabilitiesLoaded).
  const settings = resolveWebSettings(loadConfigFromEnv());
  // The runtime's turn admission, when the session has one. Without it, a
  // prompt was not routed through admission, so no state is seeded and the
  // tool is refused.
  wireWebCapability({
    pi: pi as unknown as WebPiLike,
    settings,
    admission: getTurnAdmission(pi),
  });
}

// Slice R1b — the fetch core and the pieces it is built from.
export {
  ADDRESS_POLICY_VERSION,
  type AddressPolicy,
  type AddressRefusal,
  type AddressRefusalCode,
  type AddressVerdict,
  IPV4_REGISTRY_ROWS,
  IPV6_REGISTRY_ROWS,
  ownInterfaceAddresses,
  parseAddress,
  parseIpv4Literal,
  parseIpv6Literal,
  publicUnicastPolicy,
  type RegistryRow,
} from "./address.js";
export {
  admitCandidate,
  chargeFetchAttempt,
  chargeText,
  newTurnState,
  originKey,
  recordPageLinks,
  textAllowanceRemaining,
  type WebTurnState,
} from "./admission.js";
// Slice R1c — URL provenance, the admission state and the tool.
export {
  type WebCapabilityDeps,
  type WebCapabilityHandle,
  type WebPiLike,
  wireWebCapability,
} from "./capability.js";
export {
  CONFIG_ENV_VAR,
  CONFIG_SCHEMA,
  FETCH_MAX_CHARS_CEILING,
  FETCH_MAX_CHARS_DEFAULT,
  FETCH_PER_TURN_CEILING,
  FETCH_PER_TURN_DEFAULT,
  loadConfigFromEnv,
  TEXT_PER_TURN_CEILING,
  TEXT_PER_TURN_DEFAULT,
  validateWebConfig,
  type WebConfig,
} from "./config.js";
export { resolveWebSettings, type WebSettings } from "./core.js";
export { isWebFetchError, WebFetchError, type WebFetchRefusalCode } from "./errors.js";
export {
  ALLOWED_CONTENT_TYPES,
  allowedContentType,
  type ExtractedDocument,
  extractDocument,
  extractText,
  mediaTypeOf,
  type TruncatedText,
  truncateText,
} from "./extract.js";
export {
  ACCEPT_HEADER,
  type DnsLookup,
  type FetchDeps,
  type FetchOptions,
  type FetchResult,
  fetchDocument,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  REDIRECT_STATUSES,
  resolveMaxChars,
  TOTAL_DEADLINE_MS,
  USER_AGENT,
  vettedLookup,
} from "./fetch.js";
export { webManifest } from "./manifest.js";
export {
  extractUrls,
  parseAbsolute,
  recordLinks,
  recordUrl,
  recordUrls,
  urlKey,
} from "./provenance.js";
export {
  createWebFetchTool,
  WEB_FETCH_PARAMS,
  WEB_FETCH_TOOL_NAME,
  type WebFetchFn,
  type WebFetchToolDeps,
} from "./tool.js";
export {
  type AdmitOptions,
  addressRefused,
  admitUrl,
  hasZoneIdentifier,
  type UrlPolicy,
  WEB_PORTS,
} from "./url-admission.js";
