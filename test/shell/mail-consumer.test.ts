import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailConsumer, type MailMessage } from "../../src/shell/mail-consumer.js";

describe("MailConsumer", () => {
  let tmpInbox: string;
  let tmpLock: string;

  const writeMail = (name: string, body: string): string => {
    const path = join(tmpInbox, "new", `${name}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        id: name,
        from: "flint",
        to: "testbot",
        body,
        timestamp: new Date().toISOString(),
      }),
    );
    return path;
  };

  beforeEach(() => {
    tmpInbox = mkdtempSync(join(tmpdir(), "bob-inbox-"));
    tmpLock = mkdtempSync(join(tmpdir(), "bob-lock-"));
    mkdirSync(join(tmpInbox, "new"), { recursive: true });
    mkdirSync(join(tmpInbox, "cur"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpInbox, { recursive: true, force: true });
    rmSync(tmpLock, { recursive: true, force: true });
  });

  it("rejects invalid agent names", () => {
    expect(() => new MailConsumer({ name: "../etc", inboxRoot: tmpInbox })).toThrow(
      /invalid agent name/,
    );
  });

  it("processes a new mail message and moves it to cur/", async () => {
    const seen: MailMessage[] = [];
    writeMail("msg1", "hello");

    const consumer = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile: join(tmpLock, "testbot.lock"),
      dispatch: async (msg) => {
        seen.push(msg);
      },
    });
    consumer.start();
    await consumer.poll();
    consumer.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe("hello");
    expect(existsSync(join(tmpInbox, "new", "msg1.json"))).toBe(false);
    expect(existsSync(join(tmpInbox, "cur", "msg1.json"))).toBe(true);
    expect(consumer.stats.processed).toBe(1);
  });

  it("processes mail that arrived BEFORE start (fixes openclaw startup-race bug)", async () => {
    // openclaw-tps-mail pre-populated seenFiles on boot and stranded
    // pre-existing mail. Bob must NOT do that.
    writeMail("existing", "pre-existing message");
    const seen: MailMessage[] = [];

    const consumer = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile: join(tmpLock, "testbot.lock"),
      dispatch: async (msg) => {
        seen.push(msg);
      },
    });
    consumer.start();
    await consumer.poll();
    consumer.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("existing");
  });

  it("does not double-process a message across multiple polls", async () => {
    writeMail("once", "process me exactly once");
    const seen: MailMessage[] = [];

    const consumer = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile: join(tmpLock, "testbot.lock"),
      dispatch: async (msg) => {
        seen.push(msg);
      },
    });
    consumer.start();
    await consumer.poll();
    await consumer.poll();
    await consumer.poll();
    consumer.stop();

    expect(seen).toHaveLength(1);
  });

  it("picks up mail that arrives after start()", async () => {
    const seen: MailMessage[] = [];

    const consumer = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile: join(tmpLock, "testbot.lock"),
      dispatch: async (msg) => {
        seen.push(msg);
      },
    });
    consumer.start();
    // Mail arrives AFTER start
    writeMail("postStart", "arrived after start");
    await consumer.poll();
    consumer.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("postStart");
  });

  it("counts failed dispatches in stats but doesn't crash", async () => {
    writeMail("bad", "this will fail");

    const consumer = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile: join(tmpLock, "testbot.lock"),
      dispatch: async () => {
        throw new Error("dispatch boom");
      },
    });
    consumer.start();
    await consumer.poll();
    consumer.stop();

    expect(consumer.stats.failed).toBe(1);
    expect(consumer.stats.processed).toBe(0);
    // Poison mail stays in new/ (not moved to cur on failure)
    expect(existsSync(join(tmpInbox, "new", "bad.json"))).toBe(true);
  });

  it("does not re-process a previously-failed message in the same session", async () => {
    writeMail("bad", "fail me");
    let attempts = 0;

    const consumer = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile: join(tmpLock, "testbot.lock"),
      dispatch: async () => {
        attempts += 1;
        throw new Error("nope");
      },
    });
    consumer.start();
    await consumer.poll();
    await consumer.poll();
    await consumer.poll();
    consumer.stop();

    expect(attempts).toBe(1);
  });

  it("refuses to start when another instance holds the lock", () => {
    const lockFile = join(tmpLock, "testbot.lock");
    const consumer1 = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile,
      dispatch: async () => {},
    });
    consumer1.start();

    const consumer2 = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile,
      dispatch: async () => {},
    });
    expect(() => consumer2.start()).toThrow(/already running/);
    consumer1.stop();
  });

  it("ignores non-json files in the inbox", async () => {
    const seen: MailMessage[] = [];
    writeFileSync(join(tmpInbox, "new", "ignore.txt"), "not a mail");
    writeMail("good", "real mail");

    const consumer = new MailConsumer({
      name: "testbot",
      inboxRoot: tmpInbox,
      lockFile: join(tmpLock, "testbot.lock"),
      dispatch: async (msg) => {
        seen.push(msg);
      },
    });
    consumer.start();
    await consumer.poll();
    consumer.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("good");
    // .txt file untouched
    expect(existsSync(join(tmpInbox, "new", "ignore.txt"))).toBe(true);
  });
});
