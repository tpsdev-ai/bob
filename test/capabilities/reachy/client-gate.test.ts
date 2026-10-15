import { expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";

function channel() {
  const writes: Array<{ command: string; done: (err?: Error) => void }> = [];
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    write(line: string, done: (err?: Error) => void) {
      writes.push({ command: JSON.parse(line).command, done });
    },
    end() {},
  });
  let complete!: () => void;
  let fail!: (err: Error) => void;
  const wait = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  void wait.catch(() => {});
  const client = new UnixSocketReachyClient({ socket: "/unused" });
  Object.assign(client, {
    socket,
    configured: { socket, wait, complete, fail, started: false },
  });
  return { client, writes, socket };
}

it("state and action sends wait for the configure write callback", async () => {
  const { client, writes } = channel();
  const state = client.send("state");
  const say = client.send("say", { text: "hi" });
  await Promise.resolve();
  expect(writes).toEqual([]);
  const configuring = client.send("configure");
  expect(writes.map((w) => w.command)).toEqual(["configure"]);
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  writes[0]?.done();
  await configuring;
  await Promise.resolve();
  expect(writes.map((w) => w.command)).toEqual(["configure", "state", "say"]);
  writes[1]?.done();
  writes[2]?.done();
  await Promise.all([state, say]);
  await expect(client.send("configure")).rejects.toThrow("already started");
});

it("a failed configure rejects queued sends without writing them", async () => {
  const { client, writes } = channel();
  const state = client.send("state");
  const configuring = client.send("configure");
  const stateResult = state.catch((err: unknown) => err);
  writes[0]?.done(new Error("write failed"));
  await expect(configuring).rejects.toThrow("write failed");
  expect(await stateResult).toMatchObject({ message: "write failed" });
  expect(writes.map((w) => w.command)).toEqual(["configure"]);
});

it("closing an unconfigured connection rejects its queued state", async () => {
  const { client, writes } = channel();
  const state = client.send("state");
  client.close();
  await expect(state).rejects.toThrow("client closed");
  expect(writes).toEqual([]);
});

it("a queued state cannot move onto a replacement connection", async () => {
  const { client, writes } = channel();
  const state = client.send("state");
  const configuring = client.send("configure");
  Object.assign(client, { socket: new EventEmitter() });
  const stateResult = state.catch((err: unknown) => err);
  writes[0]?.done();
  await configuring;
  expect(await stateResult).toMatchObject({
    message: "reachy: the sidecar connection changed before the write",
  });
  expect(writes.map((w) => w.command)).toEqual(["configure"]);
});
