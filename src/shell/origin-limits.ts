// Maximum characters in each runtime-authored non-run origin field. Shared by
// the admission validator and the source that supplies each field. There is no
// prompt tag or nonce: origin metadata never enters the prompt.
export const ORIGIN_FIELD_LIMITS = {
  mailFrom: 64,
  cronJob: 64,
  discordChannelId: 20,
} as const;
