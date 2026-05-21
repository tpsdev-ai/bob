// Discord bridge — listen on configured channels, dispatch messages
// through a callback, and reply back to the channel.
//
// Built around an injected DiscordClient interface so tests stay
// dep-free. Production wiring binds it to discord.js (added as an
// optional dep — milton-shell stays importable without it for callers
// who don't want Discord).
//
// PR-5 ships the bridge abstraction + the message → dispatch flow.
// PR-6 wires cron + a `milton serve --discord` flag.

export interface DiscordMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  // True if this message mentioned the agent (bot) — bridge filters
  // these vs. ambient channel chatter to keep the LLM cost down.
  mentionsBot: boolean;
}

export interface DiscordClient {
  on(event: "message", handler: (msg: DiscordMessage) => void): void;
  reply(channelId: string, text: string, opts?: { replyTo?: string }): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface DiscordBridgeOptions {
  // Which channel IDs to listen on. Other channels' messages are dropped.
  listenChannelIds: string[];
  // The client. Tests inject a stub; production binds discord.js.
  client: DiscordClient;
  // What to do with a message that passes the channel + mention filter.
  // Return text to auto-reply, or undefined to suppress.
  dispatch: (msg: DiscordMessage) => Promise<string | undefined>;
  // If true, dispatch ALL messages on listenChannelIds, not just
  // bot-mentions. Useful for EA roles that need to surface signal from
  // chatter. Default false.
  dispatchAll?: boolean;
}

export interface DiscordBridgeStats {
  received: number;
  dispatched: number;
  replied: number;
  errors: number;
}

export class DiscordBridge {
  private readonly opts: DiscordBridgeOptions;
  private connected = false;
  readonly stats: DiscordBridgeStats;

  constructor(opts: DiscordBridgeOptions) {
    if (opts.listenChannelIds.length === 0) {
      throw new Error("listenChannelIds must contain at least one channel");
    }
    this.opts = opts;
    this.stats = { received: 0, dispatched: 0, replied: 0, errors: 0 };
  }

  async start(): Promise<void> {
    if (this.connected) return;
    this.opts.client.on("message", (msg) => {
      this.handle(msg).catch((err) => {
        this.stats.errors += 1;
        // Errors are counted but don't propagate — Discord listener
        // must survive individual message failures.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        err;
      });
    });
    await this.opts.client.connect();
    this.connected = true;
  }

  async stop(): Promise<void> {
    if (!this.connected) return;
    await this.opts.client.disconnect();
    this.connected = false;
  }

  // Called per incoming message. Filters channel + mention, calls
  // dispatch, posts reply if dispatch returned text.
  async handle(msg: DiscordMessage): Promise<void> {
    this.stats.received += 1;
    if (!this.opts.listenChannelIds.includes(msg.channelId)) return;
    if (!this.opts.dispatchAll && !msg.mentionsBot) return;
    this.stats.dispatched += 1;
    const reply = await this.opts.dispatch(msg);
    if (reply !== undefined && reply.length > 0) {
      await this.opts.client.reply(msg.channelId, reply, { replyTo: msg.id });
      this.stats.replied += 1;
    }
  }
}
