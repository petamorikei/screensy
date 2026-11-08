// Protocol checks for the rendezvous server. The script starts the server with short timers and talks to it with
// WebSocket clients.
//
// Run it with `pnpm test:protocol` for the Node.js server (port 4000), or `pnpm test:protocol:cloudflare` for the
// Durable Object of screensy-cloudflare in `wrangler dev` (SERVER=cloudflare, port 8787), which runs the same rooms on
// workerd. DEBUG prints the output of the server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { configFromEnv } from "../screensy-rendezvous/rooms.ts";

// The clients use the ws package of the rendezvous server: they need terminate() and the Host header, which the
// built-in WebSocket of Node does not have
const require = createRequire(new URL("../screensy-rendezvous/package.json", import.meta.url));
const WebSocket = require("ws");

const CLOUDFLARE = process.env.SERVER === "cloudflare";
const PORT = CLOUDFLARE ? 8787 : 4000;
const SERVER_URL = `ws://localhost:${PORT}`;
const GRACE_MS = 1500; // the "left" grace period
const LOST_GRACE_MS = 4000;
const PING_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Another server on the port would get the checks instead, with other timers
const portInUse = await new Promise((resolve) => {
  const probe = net.connect(PORT, "localhost");
  probe.on("connect", () => {
    probe.destroy();
    resolve(true);
  });
  probe.on("error", () => resolve(false));
});
if (portInUse) {
  console.error(`Port ${PORT} is in use. Stop the server that uses it and try again.`);
  process.exit(1);
}

const SERVER_ENV = {
  SCREENSY_LEFT_GRACE_MS: String(GRACE_MS),
  SCREENSY_LOST_GRACE_MS: String(LOST_GRACE_MS),
  SCREENSY_PING_INTERVAL_MS: String(PING_MS),
  // The checks of takeovers are simplest with one presenter; the browser checks also run with four
  SCREENSY_MAX_PRESENTERS: "1",
  // One URL with {host} and one without
  SCREENSY_STUN_URLS: "stun:{host},stun:stun.example.com:3478",
};
const output = process.env.DEBUG ? "inherit" : "ignore";
const server = CLOUDFLARE
  ? // wrangler runs workerd as a child process, so the whole process group is stopped at the end
    spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        `--port=${PORT}`,
        "--show-interactive-dev-session=false",
        ...Object.entries(SERVER_ENV).map(([name, value]) => `--var=${name}:${value}`),
      ],
      {
        cwd: fileURLToPath(new URL("../screensy-cloudflare", import.meta.url)),
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", output, output],
        detached: true,
      },
    )
  : spawn("node", ["server.ts"], {
      cwd: fileURLToPath(new URL("../screensy-rendezvous", import.meta.url)),
      env: { ...process.env, ...SERVER_ENV },
      stdio: ["ignore", output, output],
    });
process.on("exit", () => {
  try {
    if (CLOUDFLARE) process.kill(-server.pid, "SIGTERM");
    else server.kill();
  } catch {}
});
let roomCounter = 0;
const newRoom = () => `room-${Date.now()}-${roomCounter++}`;

class Client {
  constructor(label, opts = {}) {
    this.label = label;
    this.messages = [];
    this.waiters = [];
    this.pings = 0;
    this.ws = new WebSocket(SERVER_URL, { headers: opts.headers });
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      // The heartbeat is answered like the browser client does, and kept out of the other messages
      if (m.type === "ping") {
        this.pings++;
        if (opts.answerPings ?? true) this.send({ type: "pong" });
        return;
      }
      const w = this.waiters.find((w) => w.pred(m));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      } else {
        this.messages.push(m);
      }
    });
    this.closed = new Promise((r) => this.ws.on("close", r));
    this.opened = new Promise((r) => this.ws.on("open", r));
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  next(pred, timeout = 3000) {
    const found = this.messages.find(pred);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`${this.label}: timeout waiting for message`));
        }
      }, timeout);
    });
  }
  type(t, extra, timeout) {
    return this.next((m) => m.type === t && (extra?.(m) ?? true), timeout);
  }
  async none(pred, ms = 400) {
    await sleep(ms);
    assert.ok(!this.messages.some(pred), `${this.label}: unexpected message`);
  }
  drain() {
    this.messages = [];
  }
  async join(roomId, name, resumeToken) {
    await this.opened;
    this.send({ type: "join", roomId, name: name ?? "", resumeToken });
    this.welcome = await this.type("welcome");
    return this.welcome;
  }
  async present(resume, replace) {
    this.send({ type: "present", resume: resume ?? false, replace });
    return this.next((m) => m.type === "presentaccepted" || m.type === "presentrejected");
  }
  close() {
    this.ws.close();
    return this.closed;
  }
  // Ends the TCP connection without a close frame, like a broken network: the server sees code 1006
  terminate() {
    this.ws.terminate();
    return this.closed;
  }
}

const lastState = async (c, pred = () => true) => c.type("roomstate", pred);

const tests = [];
// nodeOnly: a check of the Node.js entry point (server.ts), which the Worker does not have
const test = (name, fn, { nodeOnly = false } = {}) => {
  if (!(nodeOnly && CLOUDFLARE)) tests.push({ name, fn });
};

test("join gets welcome and roomstate", async () => {
  const room = newRoom();
  const a = new Client("a");
  const w = await a.join(room, "Alice");
  assert.equal(typeof w.selfId, "string");
  assert.equal(typeof w.connectionId, "string");
  assert.equal(typeof w.resumeToken, "string");
  assert.equal(w.maxPresenters, 1);
  const s = await lastState(a);
  assert.deepEqual(s.participants, [{ id: w.selfId, connectionId: w.connectionId, name: "Alice", connected: true }]);
  assert.deepEqual(s.presenters, []);
  await a.close();
});

test("welcome lists the STUN servers, with {host} replaced", async () => {
  const a = new Client("a");
  const w = await a.join(newRoom(), "A");
  assert.deepEqual(w.iceServers, [{ urls: ["stun:localhost", "stun:stun.example.com:3478"] }]);
  await a.close();
});

test("without SCREENSY_STUN_URLS, the clients get Cloudflare's public STUN server", () => {
  assert.deepEqual(configFromEnv({}).config.stunUrls, ["stun:stun.cloudflare.com:3478"]);
  assert.deepEqual(configFromEnv({ SCREENSY_STUN_URLS: "" }).config.stunUrls, []);
});

test(
  "invalid STUN URLs stop the server at start",
  async () => {
    for (const [name, value] of [
      ["SCREENSY_STUN_URLS", "stun://{host}"],
      ["SCREENSY_STUN_URLS", "http://example.com"],
    ]) {
      // It exits before it listens, so port 4000 of the running server does not matter
      const child = spawn("node", ["server.ts"], {
        cwd: fileURLToPath(new URL("../screensy-rendezvous", import.meta.url)),
        env: { ...process.env, [name]: value },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      const code = await new Promise((resolve) => child.on("exit", resolve));
      assert.equal(code, 1, `${name}=${value} stops the server`);
      assert.match(stderr, new RegExp(`${name} has invalid URLs`));
    }
  },
  { nodeOnly: true },
);

test(
  "a malformed Host header leaves out the {host} servers, and the server keeps running",
  async () => {
    const room = newRoom();
    const bad = new Client("bad", { headers: { Host: "[" } });
    const w = await bad.join(room, "Bad");
    assert.deepEqual(w.iceServers, [{ urls: ["stun:stun.example.com:3478"] }]);
    const good = new Client("good");
    const w2 = await good.join(room, "Good");
    assert.deepEqual(w2.iceServers, [{ urls: ["stun:localhost", "stun:stun.example.com:3478"] }]);
    await bad.close();
    await good.close();
  },
  { nodeOnly: true },
);

test("present and takeover", async () => {
  const room = newRoom();
  const a = new Client("a");
  const b = new Client("b");
  await a.join(room, "A");
  await b.join(room, "B");
  const acc = await a.present();
  assert.equal(acc.type, "presentaccepted");
  await lastState(b, (s) => s.presenters.length === 1 && s.presenters[0].participantId === a.welcome.selfId);
  // The room is full (MAX_PRESENTERS = 1), so B names the presenter to take over
  const acc2 = await b.present(false, a.welcome.selfId);
  assert.equal(acc2.type, "presentaccepted");
  assert.notEqual(acc2.streamId, acc.streamId);
  const s = await lastState(a, (s) => s.presenters[0]?.participantId === b.welcome.selfId);
  assert.equal(s.presenters.length, 1);
  assert.equal(s.presenters[0].status, "live");
  assert.equal(s.presenters[0].disconnectReason, null);
  assert.equal(s.presenters[0].graceRemainingMs, null);
  await a.close();
  await b.close();
});

test("a full room only takes a presenter who names one to take over", async () => {
  const room = newRoom();
  const a = new Client("a");
  const b = new Client("b");
  await a.join(room, "A");
  await b.join(room, "B");
  await a.present();
  for (const replace of [undefined, "999", b.welcome.selfId]) {
    const r = await b.present(false, replace);
    assert.equal(r.type, "presentrejected", `replace: ${replace}`);
    assert.equal(r.reason, "full");
  }
  const v = new Client("v");
  await v.join(room, "V");
  const s = await lastState(v);
  assert.deepEqual(
    s.presenters.map((p) => p.participantId),
    [a.welcome.selfId],
    "A still presents",
  );
  const acc = await b.present(false, a.welcome.selfId);
  assert.equal(acc.type, "presentaccepted");
  await lastState(v, (s) => s.presenters.length === 1 && s.presenters[0].participantId === b.welcome.selfId);
  await a.close();
  await b.close();
  await v.close();
});

test("replace is ignored below the limit", async () => {
  const room = newRoom();
  const a = new Client("a");
  await a.join(room, "A");
  const acc = await a.present(false, "999");
  assert.equal(acc.type, "presentaccepted");
  const s = await lastState(a, (s) => s.presenters.length === 1);
  assert.equal(s.presenters[0].participantId, a.welcome.selfId);
  await a.close();
});

test("clean close -> reason left with the short grace period", async () => {
  const room = newRoom();
  const a = new Client("a");
  const v = new Client("v");
  await a.join(room, "A");
  await v.join(room, "V");
  await a.present();
  await a.close();
  const s = await lastState(v, (s) => s.presenters[0]?.status === "reconnecting");
  assert.equal(s.presenters[0].disconnectReason, "left");
  assert.ok(s.presenters[0].graceRemainingMs > GRACE_MS - 300 && s.presenters[0].graceRemainingMs <= GRACE_MS);
  const t0 = Date.now();
  await lastState(v, (s) => s.presenters.length === 0, GRACE_MS + 1500);
  assert.ok(Date.now() - t0 < GRACE_MS + 500, "expired after the left grace period");
  await v.close();
});

test("broken connection -> reason lost with the long grace period", async () => {
  const room = newRoom();
  const a = new Client("a");
  const v = new Client("v");
  await a.join(room, "A");
  await v.join(room, "V");
  await a.present();
  await a.terminate();
  const s = await lastState(v, (s) => s.presenters[0]?.status === "reconnecting");
  assert.equal(s.presenters[0].disconnectReason, "lost");
  assert.ok(
    s.presenters[0].graceRemainingMs > LOST_GRACE_MS - 300 && s.presenters[0].graceRemainingMs <= LOST_GRACE_MS,
  );
  // Still held after the short grace period
  await sleep(GRACE_MS + 500);
  v.drain();
  const v2 = new Client("v2");
  await v2.join(room, "V2");
  const s2 = await lastState(v2);
  assert.equal(s2.presenters[0]?.disconnectReason, "lost");
  assert.ok(s2.presenters[0].graceRemainingMs < LOST_GRACE_MS - GRACE_MS, "remaining time counts down");
  await lastState(v, (s) => s.presenters.length === 0, LOST_GRACE_MS);
  await v.close();
  await v2.close();
});

test("heartbeat timeout of a presenter -> reason lost", async () => {
  const room = newRoom();
  const dead = new Client("dead", { answerPings: false });
  const v = new Client("v");
  await dead.join(room, "D");
  await v.join(room, "V");
  await dead.present();
  const s = await lastState(v, (s) => s.presenters[0]?.status === "reconnecting", PING_MS * 3 + 1000);
  assert.equal(s.presenters[0].disconnectReason, "lost");
  await v.close();
});

test("rejoin within the grace period -> no time limit until resumed", async () => {
  const room = newRoom();
  const a = new Client("a");
  const v = new Client("v");
  await a.join(room, "A");
  await v.join(room, "V");
  await a.present();
  await a.close();
  await lastState(v, (s) => s.presenters[0]?.status === "reconnecting");
  const a2 = new Client("a2");
  await a2.join(room, "A", a.welcome.resumeToken);
  const s = await lastState(
    v,
    (s) =>
      s.presenters[0]?.status === "reconnecting" &&
      s.participants.find((p) => p.id === a.welcome.selfId)?.connected === true,
  );
  assert.equal(s.presenters[0].graceRemainingMs, null);
  await sleep(GRACE_MS + 500);
  v.drain();
  const v2 = new Client("v2");
  await v2.join(room, "V2");
  assert.equal((await lastState(v2)).presenters[0]?.participantId, a.welcome.selfId, "seat still held");
  await a2.present(true);
  const s2 = await lastState(v, (s) => s.presenters[0]?.status === "live");
  assert.equal(s2.presenters[0].disconnectReason, null);
  assert.equal(s2.presenters[0].graceRemainingMs, null);
  await a2.close();
  await v.close();
  await v2.close();
});

test("presenter disconnect -> reconnecting -> resume with token", async () => {
  const room = newRoom();
  const a = new Client("a");
  const v = new Client("v");
  await a.join(room, "A");
  await v.join(room, "V");
  const acc = await a.present();
  await a.close();
  const s = await lastState(v, (s) => s.presenters[0]?.status === "reconnecting");
  assert.equal(s.participants.find((p) => p.id === a.welcome.selfId).connected, false);
  const a2 = new Client("a2");
  const w2 = await a2.join(room, "A", a.welcome.resumeToken);
  assert.equal(w2.selfId, a.welcome.selfId);
  assert.notEqual(w2.connectionId, a.welcome.connectionId);
  const s2 = await lastState(a2);
  assert.equal(s2.presenters[0].status, "reconnecting");
  const acc2 = await a2.present(true);
  assert.equal(acc2.type, "presentaccepted");
  assert.notEqual(acc2.streamId, acc.streamId);
  await lastState(v, (s) => s.presenters[0]?.status === "live" && s.presenters[0].streamId === acc2.streamId);
  // Grace timer must have been cleared
  await sleep(GRACE_MS + 300);
  const v2 = new Client("v2");
  await v2.join(room, "V2");
  const s3 = await lastState(v2);
  assert.equal(s3.presenters[0]?.participantId, a.welcome.selfId);
  await a2.close();
  await v.close();
  await v2.close();
});

test("grace expiry removes presenter and participant", async () => {
  const room = newRoom();
  const a = new Client("a");
  const v = new Client("v");
  await a.join(room, "A");
  await v.join(room, "V");
  await a.present();
  await lastState(v, (s) => s.presenters.length === 1);
  v.drain();
  await a.close();
  const s = await lastState(v, (s) => s.presenters.length === 0, GRACE_MS + 1500);
  assert.equal(s.participants.length, 1);
  await v.close();
});

test("takeover during grace -> resume rejected, token gives new participant", async () => {
  const room = newRoom();
  const a = new Client("a");
  const b = new Client("b");
  await a.join(room, "A");
  await b.join(room, "B");
  await a.present();
  await a.close();
  await lastState(b, (s) => s.presenters[0]?.status === "reconnecting");
  await b.present(false, a.welcome.selfId);
  const s = await lastState(b, (s) => s.presenters[0]?.participantId === b.welcome.selfId);
  assert.ok(!s.participants.some((p) => p.id === a.welcome.selfId), "evicted grace participant removed");
  const a2 = new Client("a2");
  const w2 = await a2.join(room, "A", a.welcome.resumeToken);
  assert.notEqual(w2.selfId, a.welcome.selfId);
  const r = await a2.present(true);
  assert.equal(r.type, "presentrejected");
  assert.equal(r.reason, "seat-lost");
  await a2.close();
  await b.close();
});

test("socket replacement while old socket open", async () => {
  const room = newRoom();
  const a = new Client("a");
  const v = new Client("v");
  await a.join(room, "A");
  await v.join(room, "V");
  await a.present();
  const a2 = new Client("a2");
  const w2 = await a2.join(room, "A", a.welcome.resumeToken);
  assert.equal(w2.selfId, a.welcome.selfId);
  assert.notEqual(w2.connectionId, a.welcome.connectionId);
  await a.type("replaced");
  await a.closed;
  const s = await lastState(v, (s) => s.presenters[0]?.status === "reconnecting");
  assert.equal(s.presenters[0].disconnectReason, "left");
  assert.equal(s.presenters[0].graceRemainingMs, null);
  const p = s.participants.find((p) => p.id === a.welcome.selfId);
  assert.equal(p.connected, true);
  assert.equal(p.connectionId, w2.connectionId);
  // The late close of the old socket must not disconnect the new one
  await sleep(300);
  v.drain();
  const acc = await a2.present(true);
  assert.equal(acc.type, "presentaccepted");
  const s2 = await lastState(v, (s) => s.presenters[0]?.status === "live");
  assert.equal(s2.participants.find((p) => p.id === a.welcome.selfId).connected, true);
  await a2.close();
  await v.close();
});

test("signal relay validation", async () => {
  const room = newRoom();
  const p = new Client("p");
  const v1 = new Client("v1");
  const v2 = new Client("v2");
  await p.join(room, "P");
  await v1.join(room, "V1");
  await v2.join(room, "V2");
  const acc = await p.present();
  const sig = (to, toConnection, streamId = acc.streamId) => ({
    type: "signal",
    to: to.welcome.selfId,
    toConnection,
    streamId,
    kind: "offer",
    message: { sdp: "x", type: "offer" },
  });
  // presenter -> viewer: relayed
  p.send(sig(v1, v1.welcome.connectionId));
  const got = await v1.type("signal");
  assert.equal(got.from, p.welcome.selfId);
  assert.equal(got.fromConnection, p.welcome.connectionId);
  assert.equal(got.streamId, acc.streamId);
  // viewer -> presenter: relayed
  v1.send({ ...sig(p, p.welcome.connectionId), kind: "answer" });
  await p.type("signal", (m) => m.from === v1.welcome.selfId);
  // viewer -> viewer: dropped
  v1.send(sig(v2, v2.welcome.connectionId));
  // wrong connection: dropped
  p.send(sig(v2, "999999"));
  // unknown stream: dropped
  p.send(sig(v2, v2.welcome.connectionId, "999999"));
  await v2.none((m) => m.type === "signal");
  // stale stream after re-present: dropped
  const acc2 = await p.present();
  p.send(sig(v2, v2.welcome.connectionId, acc.streamId));
  await v2.none((m) => m.type === "signal");
  p.send(sig(v2, v2.welcome.connectionId, acc2.streamId));
  await v2.type("signal");
  // old connectionId after replacement: dropped
  const v1b = new Client("v1b");
  await v1b.join(room, "V1", v1.welcome.resumeToken);
  p.send(sig(v1b, v1.welcome.connectionId, acc2.streamId));
  await v1b.none((m) => m.type === "signal");
  p.send(sig(v1b, v1b.welcome.connectionId, acc2.streamId));
  await v1b.type("signal");
  await p.close();
  await v1b.close();
  await v2.close();
});

test("signal payloads are validated, and relayed with every field", async () => {
  const room = newRoom();
  const p = new Client("p");
  const v = new Client("v");
  await p.join(room, "P");
  await v.join(room, "V");
  const acc = await p.present();
  const sig = (kind, message) => ({
    type: "signal",
    to: v.welcome.selfId,
    toConnection: v.welcome.connectionId,
    streamId: acc.streamId,
    kind,
    message,
  });
  // Malformed payloads: dropped
  p.send(sig("offer", { type: "offer", sdp: 5 }));
  p.send(sig("offer", "v=0"));
  p.send(sig("candidate", { candidate: "candidate:1", sdpMLineIndex: "0" }));
  p.send(sig("bogus", { type: "offer", sdp: "x" }));
  await v.none((m) => m.type === "signal");
  // RTCIceCandidate.toJSON() sends null for the fields that it does not know
  const candidate = { candidate: "candidate:1", sdpMid: null, sdpMLineIndex: null, usernameFragment: null };
  p.send(sig("candidate", candidate));
  const got = await v.type("signal");
  assert.equal(got.kind, "candidate");
  assert.deepEqual(got.message, candidate);
  assert.equal(got.to, undefined, "the recipient fields are not relayed");
  await p.close();
  await v.close();
});

test("name normalization and setname", async () => {
  const room = newRoom();
  const a = new Client("a");
  await a.join(room, `  ${"あ".repeat(40)}  `);
  const s = await lastState(a);
  assert.equal(s.participants[0].name, "あ".repeat(32));
  a.send({ type: "setname", name: "  Bob " });
  await lastState(a, (s) => s.participants[0].name === "Bob");
  a.drain();
  a.send({ type: "setname", name: 42 });
  await a.none((m) => m.type === "roomstate");
  await a.close();
});

test("streamstate only from the stream's presenter", async () => {
  const room = newRoom();
  const p = new Client("p");
  const v = new Client("v");
  await p.join(room, "P");
  await v.join(room, "V");
  const acc = await p.present();
  await lastState(v, (s) => s.presenters.length === 1);
  v.drain();
  v.send({ type: "streamstate", streamId: acc.streamId, hidden: true });
  await v.none((m) => m.type === "roomstate");
  p.send({ type: "streamstate", streamId: acc.streamId, hidden: true });
  await lastState(v, (s) => s.presenters[0].hidden === true);
  await p.close();
  await v.close();
});

test("stoppresenting frees the seat; viewer disconnect removes immediately", async () => {
  const room = newRoom();
  const p = new Client("p");
  const v = new Client("v");
  await p.join(room, "P");
  await v.join(room, "V");
  await p.present();
  p.send({ type: "stoppresenting" });
  await lastState(v, (s) => s.presenters.length === 0);
  await v.close();
  await lastState(p, (s) => s.participants.length === 1);
  await p.close();
});

test("heartbeat terminates clients that do not answer pings", async () => {
  const room = newRoom();
  const dead = new Client("dead", { answerPings: false });
  const v = new Client("v");
  await dead.join(room, "D");
  await v.join(room, "V");
  await lastState(v, (s) => s.participants.length === 2);
  await lastState(v, (s) => s.participants.length === 1, PING_MS * 3 + 1000);
  await dead.closed;
  await v.close();
});

test("a client that answers the pings stays, also before it joins", async () => {
  const room = newRoom();
  const a = new Client("a");
  const early = new Client("early");
  await a.join(room, "A");
  await early.opened;
  await sleep(PING_MS * 3 + 500);
  assert.ok(a.pings >= 2, "the server sends pings");
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  assert.equal(early.ws.readyState, WebSocket.OPEN);
  await early.join(room, "Early");
  const s = await lastState(a, (s) => s.participants.length === 2);
  assert.ok(s.participants.every((p) => p.connected));
  await a.close();
  await early.close();
});

test("a connection that never joins nor answers is dropped", async () => {
  const silent = new Client("silent", { answerPings: false });
  await silent.opened;
  const end = Date.now() + PING_MS * 3 + 1000;
  await Promise.race([silent.closed, sleep(PING_MS * 3 + 1000)]);
  assert.ok(Date.now() < end, "the server closes it");
});

test("empty room is deleted (rejoin gets a fresh room)", async () => {
  const room = newRoom();
  const a = new Client("a");
  await a.join(room, "A");
  await a.close();
  await sleep(200);
  const b = new Client("b");
  const w = await b.join(room, "B", a.welcome.resumeToken);
  assert.equal(w.selfId, "0", "ids restart in a fresh room");
  const s = await lastState(b);
  assert.equal(s.participants.length, 1);
  await b.close();
});

test("messages before join and invalid messages are ignored", async () => {
  const room = newRoom();
  const a = new Client("a");
  await a.opened;
  a.send({ type: "present", resume: false });
  a.ws.send("not json");
  a.ws.send("[1,2]");
  await a.none(() => true);
  await a.join(room, "A");
  a.send({ type: "signal", to: "0" });
  a.send({ type: "nonsense" });
  await sleep(200);
  await a.close();
});

// Wait until the server accepts connections
for (let attempt = 0; ; attempt++) {
  const ready = await new Promise((resolve) => {
    const probe = new WebSocket(SERVER_URL);
    probe.on("open", () => {
      probe.close();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
  if (ready) break;
  // wrangler takes a few seconds to start
  if (attempt === (CLOUDFLARE ? 600 : 50)) throw new Error("the rendezvous server did not start");
  await sleep(100);
}

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${e.stack}`);
  }
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
