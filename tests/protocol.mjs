// Protocol checks for the rendezvous server. The script starts the server on port 4000 with short timers and talks to
// it with WebSocket clients.
//
// Run it with `pnpm test:protocol`. DEBUG prints the output of the server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { fileURLToPath } from "node:url";

// The clients use the ws package of the rendezvous server: they need terminate() and autoPong, which the built-in
// WebSocket of Node does not have
const require = createRequire(new URL("../screensy-rendezvous/package.json", import.meta.url));
const WebSocket = require("ws");

const SERVER_URL = "ws://localhost:4000";
const GRACE_MS = 1500; // the "left" grace period
const LOST_GRACE_MS = 4000;
const PING_MS = 1000;
const TURN_SECRET = "test-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Another server on the port would get the checks instead, with other timers
const portInUse = await new Promise((resolve) => {
  const probe = net.connect(4000, "localhost");
  probe.on("connect", () => {
    probe.destroy();
    resolve(true);
  });
  probe.on("error", () => resolve(false));
});
if (portInUse) {
  console.error("Port 4000 is in use. Stop the server that uses it and try again.");
  process.exit(1);
}

const server = spawn("node", ["server.ts"], {
  cwd: fileURLToPath(new URL("../screensy-rendezvous", import.meta.url)),
  env: {
    ...process.env,
    SCREENSY_LEFT_GRACE_MS: String(GRACE_MS),
    SCREENSY_LOST_GRACE_MS: String(LOST_GRACE_MS),
    SCREENSY_PING_INTERVAL_MS: String(PING_MS),
    // The checks of takeovers are simplest with one presenter; the browser checks also run with four
    SCREENSY_MAX_PRESENTERS: "1",
    // STUN keeps its default (stun:{host}); TURN gets two URLs and a secret
    SCREENSY_TURN_URLS: "turn:{host}:3479,turns:{host}:5349",
    SCREENSY_TURN_SECRET: TURN_SECRET,
  },
  stdio: ["ignore", process.env.DEBUG ? "inherit" : "ignore", process.env.DEBUG ? "inherit" : "ignore"],
});
process.on("exit", () => server.kill());
let roomCounter = 0;
const newRoom = () => `room-${Date.now()}-${roomCounter++}`;

class Client {
  constructor(label, opts = {}) {
    this.label = label;
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(SERVER_URL, { autoPong: opts.autoPong ?? true, headers: opts.headers });
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
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
const test = (name, fn) => tests.push({ name, fn });

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

// The temporary TURN username of coturn's TURN REST API: "<expiry in Unix seconds>:<participant ID>", signed with
// HMAC-SHA1 and the shared secret
const assertTurnCredentials = (server, participantId) => {
  const [expiry, name] = server.username.split(":");
  assert.equal(name, participantId);
  const expected = Date.now() / 1000 + 86_400;
  assert.ok(Math.abs(Number(expiry) - expected) < 10, `expiry ${expiry} is about a day from now`);
  assert.equal(server.credential, createHmac("sha1", TURN_SECRET).update(server.username).digest("base64"));
};

test("welcome lists the STUN and TURN servers, with temporary TURN credentials", async () => {
  const room = newRoom();
  const a = new Client("a");
  const w = await a.join(room, "A");
  assert.equal(w.iceServers.length, 2);
  assert.deepEqual(w.iceServers[0], { urls: ["stun:localhost"] });
  assert.deepEqual(w.iceServers[1].urls, ["turn:localhost:3479", "turns:localhost:5349"]);
  assertTurnCredentials(w.iceServers[1], w.selfId);
  // A rejoin gets new credentials
  const b = new Client("a2");
  await sleep(1100);
  const w2 = await b.join(room, "A", w.resumeToken);
  assertTurnCredentials(w2.iceServers[1], w.selfId);
  assert.notEqual(w2.iceServers[1].username, w.iceServers[1].username);
  await a.closed;
  await b.close();
});

test("a malformed Host header leaves out the {host} servers, and the server keeps running", async () => {
  const room = newRoom();
  const bad = new Client("bad", { headers: { Host: "[" } });
  const w = await bad.join(room, "Bad");
  // Every URL uses {host}, so there is nothing to list
  assert.deepEqual(w.iceServers, []);
  const good = new Client("good");
  const w2 = await good.join(room, "Good");
  assert.equal(w2.iceServers.length, 2);
  await bad.close();
  await good.close();
});

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
  const dead = new Client("dead", { autoPong: false });
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
  const dead = new Client("dead", { autoPong: false });
  const v = new Client("v");
  await dead.join(room, "D");
  await v.join(room, "V");
  await lastState(v, (s) => s.participants.length === 2);
  await lastState(v, (s) => s.participants.length === 1, PING_MS * 3 + 1000);
  await dead.closed;
  await v.close();
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
  if (attempt === 50) throw new Error("the rendezvous server did not start");
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
