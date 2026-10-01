// Bob capability: web — a pi extension (bob#152, spec v3, slice R1a).
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => void`. The extension validates the resolved config
// block Bob hands it in BOB_CAP_WEB, against the same schema the catalog
// validated bob.yaml with, and REGISTERS NO TOOL. The fetch core (address
// policy, redirects, limits, extraction) is slice R1b and lives in fetch.ts; it
// is an internal module, exported here for `web_fetch` (R1c) and its tests, and
// no config reaches it yet.
//
// A session that holds this capability (or allows an egress tool) is a WEB
// session. bob refuses to compose one with anything private beyond its
// admitted prompt (data-class.ts): at YAML load over the capability set, in the
// session factory before pi's runtime is built, and on the composed session at
// creation, after the mode binds extensions and after every reload. A web
// session sends bob's reviewed system prompt in place of pi's template and has
// no agent workspace (pi's working directory is "/").

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfigFromEnv } from "./config.js";

export default function (_pi: ExtensionAPI): void {
  // A bad block fails the extension load, which bob turns into a named
  // session refusal (session.ts assertCapabilitiesLoaded).
  loadConfigFromEnv();
}

// Slice R1b — the fetch core and the pieces it is built from. Internal: no tool
// is registered from these, and R1c is what will call fetchDocument.
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
  type AdmitOptions,
  addressRefused,
  admitUrl,
  hasZoneIdentifier,
  type UrlPolicy,
  WEB_PORTS,
} from "./url-admission.js";
