// Browser checks for screensy: two or more headless Chrome pages in one room, driven over CDP with Node's built-in
// WebSocket. The script starts the rendezvous server, the website, a proxy that routes like the Caddyfile, and Chrome.
//
// Run it with `pnpm test:e2e`. It needs Go and Chrome, and the ports 4000, 8080, 8090 and 9333.
// - CHROME: the Chrome binary (default: the macOS install location)
// - SHOTS: a directory to save screenshots of the UI into
// - DEBUG: print the output of the servers
//
// Chrome cannot accept the screen picker in headless mode, so getDisplayMedia returns a canvas stream instead. Chrome
// keeps its default mDNS host candidates, like a real browser.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.SHOTS;
const PROXY_PORT = 8090;
const CDP_PORT = 9333;
const ORIGIN = `http://localhost:${PROXY_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function run(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  children.push(child);
  return child;
}
function cleanup() {
  for (const c of children) c.kill("SIGKILL");
}
process.on("exit", cleanup);

const proxySockets = new Map();
const proxyBlocked = new Set();

// Breaks the tagged WebSockets without a close frame, like a broken network. The server sees code 1006.
function dropSockets(tag) {
  for (const { socket, upstream } of proxySockets.get(tag) ?? []) {
    socket.destroy();
    upstream.destroy();
  }
  proxySockets.delete(tag);
}

// Same routing as the Caddyfile: WebSocket upgrades to 4000, everything else to 8080
function startProxy() {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "localhost", port: 8080, path: req.url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    // A page can tag its WebSockets with the cookie "e2e=<tag>", to have them dropped or blocked by the test
    const tag = /(?:^|;\s*)e2e=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (tag != null && proxyBlocked.has(tag)) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(4000, "localhost", () => {
      if (tag != null) {
        if (!proxySockets.has(tag)) proxySockets.set(tag, new Set());
        proxySockets.get(tag).add({ socket, upstream });
      }
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      upstream.write(`${raw}\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  server.listen(PROXY_PORT);
  return server;
}

async function waitHttp(url, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    this.open = new Promise((r) => (this.ws.onopen = r));
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const INIT_SCRIPT = `
(() => {
  window.__sockets = [];
  window.__roomState = null;
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      window.__sockets.push(this);
      this.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "roomstate") window.__roomState = message;
      });
    }
  };

  // Every connection, and every track passed to replaceTrack. __replaceHook(sender, track) can delay or fail it.
  window.__pcs = [];
  window.__replaced = [];
  window.__replaceHook = null;
  const NativePeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeerConnection {
    constructor(...args) { super(...args); window.__pcs.push(this); }
    addTransceiver(...args) { const transceiver = super.addTransceiver(...args); transceiver.sender.__pc = this; return transceiver; }
  };
  // How often the page reads the statistics
  window.__getStatsCalls = 0;
  const nativeGetStats = NativePeerConnection.prototype.getStats;
  NativePeerConnection.prototype.getStats = function (...args) { window.__getStatsCalls++; return nativeGetStats.apply(this, args); };
  const nativeReplaceTrack = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = async function (track) {
    window.__replaced.push({ kind: track?.kind ?? null, enabled: track?.enabled ?? null, type: track?.constructor.name ?? null });
    if (window.__replaceHook) await window.__replaceHook(this, track);
    return nativeReplaceTrack.call(this, track);
  };

  // Headless Chrome cannot accept the screen picker. __nextCapture sets the size, a fixed color and audio of the next
  // capture, and its frame rate; by default it is 640x360 at 20 fps, with changing colors and no audio.
  window.__captures = [];
  window.__nextCapture = null;
  navigator.mediaDevices.getDisplayMedia = async (displayOptions) => {
    window.__displayOptions = displayOptions;
    if (window.__denyCapture) throw new DOMException("denied", "NotAllowedError");
    const options = window.__nextCapture ?? {};
    window.__nextCapture = null;
    const width = options.width ?? 640;
    const height = options.height ?? 360;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    let i = 0;
    const frameRate = options.frameRate ?? 20;
    // A black and white checkerboard of 16 px squares, to measure how sharp the received video is
    let fill = options.color;
    if (options.pattern === "checker") {
      const tile = document.createElement("canvas");
      tile.width = 32;
      tile.height = 32;
      const tileContext = tile.getContext("2d");
      tileContext.fillStyle = "white";
      tileContext.fillRect(0, 0, 32, 32);
      tileContext.fillStyle = "black";
      tileContext.fillRect(0, 0, 16, 16);
      tileContext.fillRect(16, 16, 16, 16);
      fill = context.createPattern(tile, "repeat");
    }
    setInterval(() => { context.fillStyle = fill ?? "hsl(" + ((i++ * 15) % 360) + " 80% 50%)"; context.fillRect(0, 0, width, height); }, 1000 / frameRate);
    const stream = canvas.captureStream(frameRate);
    if (options.audio) {
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
    }
    window.__captures.push(stream);
    return stream;
  };
})();
`;

// The average color and the size of what the page's <video> shows, or null if it shows nothing
const VIDEO_COLOR = `(() => {
  const video = document.getElementById("stream");
  if (video.videoWidth === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 18;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, 32, 18);
  const data = context.getImageData(0, 0, 32, 18).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  const n = data.length / 4;
  return { r: r / n, g: g / n, b: b / n, width: video.videoWidth, height: video.videoHeight };
})()`;

async function waitColor(page, desc, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await page.eval(VIDEO_COLOR);
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`${page.label}: timeout waiting for ${desc}\nlast color: ${JSON.stringify(last)}`);
}

const PAGE_STATE = `(() => {
  const visible = (sel) => [...document.querySelectorAll(sel)].filter((e) => !e.classList.contains("hidden") && !e.closest(".hidden")).map((e) => e.id);
  const video = document.getElementById("stream");
  const src = video.srcObject;
  const capture = window.__captures.at(-1);
  return {
    status: document.getElementById("status").classList.contains("hidden") ? null : visible("#status > p")[0] ?? null,
    statusText: document.querySelector("#status > p:not(.hidden)")?.textContent.trim().replace(/\\s+/g, " ") ?? null,
    notices: visible(".notice"),
    noticeText: [...document.querySelectorAll(".notice:not(.hidden) p")].map((p) => p.textContent.trim().replace(/\\s+/g, " ")),
    dialogOpen: document.getElementById("present-dialog").open,
    dialogMode: [...document.querySelectorAll("#present-dialog h1[data-mode]")].find((e) => !e.classList.contains("hidden"))?.dataset.mode ?? null,
    // The presenters to choose from in a full room, or null when the dialog does not ask
    replaceOptions: document.getElementById("present-replace").classList.contains("hidden") ? null : [...document.querySelectorAll("#present-replace-options label")].map((label) => ({ name: label.textContent.trim(), checked: label.querySelector("input").checked })),
    nameValue: document.getElementById("present-name").value,
    toolbar: visible("#toolbar button, #viewer-count"),
    viewers: document.getElementById("viewer-count-value").textContent,
    videoLocal: capture != null && src === capture,
    videoPlaying: src != null && src !== capture && video.videoWidth > 0 && !video.paused,
    captureLive: capture != null && capture.getVideoTracks()[0].readyState === "live",
    hash: location.hash,
    lang: document.documentElement.lang,
  };
})()`;

class Page {
  constructor(cdp, sessionId, label) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.label = label;
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }
  async eval(expression, userGesture = false) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (r.exceptionDetails)
      throw new Error(`${this.label}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  state() {
    return this.eval(PAGE_STATE);
  }
  async waitFor(desc, pred, timeout = 10000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.state();
        if (pred(last)) return last;
      } catch (e) {
        last = String(e);
      }
      await sleep(200);
    }
    throw new Error(`${this.label}: timeout waiting for ${desc}\nlast state: ${JSON.stringify(last, null, 1)}`);
  }
  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitLoaded();
  }
  async reload() {
    await this.send("Page.reload", {});
    await sleep(300);
    await this.waitLoaded();
  }
  async waitLoaded() {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      try {
        if ((await this.eval("document.readyState")) === "complete") return;
      } catch {}
      await sleep(100);
    }
    throw new Error(`${this.label}: page did not load`);
  }
  // Fills in the name and submits the dialog, with a user gesture like a real click
  submitDialog(name) {
    return this.eval(
      `(() => { const i = document.getElementById("present-name"); i.value = ${JSON.stringify(name)}; document.querySelector("#present-form button[type=submit]").click(); })()`,
      true,
    );
  }
  async shot(name) {
    if (!SHOTS) return;
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: 960,
      height: 540,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(400);
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  }
  click(selector) {
    return this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
  }
}

async function newPage(cdp, label, { acceptLanguage = "en-US", initExtra = "" } = {}) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  return newPageInContext(cdp, label, browserContextId, { acceptLanguage, initExtra });
}

async function newPageInContext(cdp, label, browserContextId, { acceptLanguage = "en-US", initExtra = "" } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId, label);
  page.targetId = targetId;
  page.browserContextId = browserContextId;
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Network.setExtraHTTPHeaders", { headers: { "Accept-Language": acceptLanguage } });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT_SCRIPT + initExtra });
  return page;
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push(false);
    console.log(
      `FAIL ${name}\n     ${String(e.stack ?? e)
        .split("\n")
        .join("\n     ")}`,
    );
    throw e;
  }
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const probe = net.connect(port, "localhost");
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
}

async function main() {
  // Other servers on these ports would get the checks instead, with other timers
  const busy = [];
  for (const port of [4000, 8080, PROXY_PORT, CDP_PORT]) {
    if (await isPortInUse(port)) busy.push(port);
  }
  if (busy.length > 0) {
    throw new Error(`Ports in use: ${busy.join(", ")}. Stop the servers that use them and try again.`);
  }

  // Build the website first: "go run" would start it as a child process that cleanup() could not kill
  const website = join(mkdtempSync(join(tmpdir(), "screensy-website-")), "screensy-website");
  execFileSync("go", ["build", "-o", website, "."], { cwd: join(REPO, "screensy-website"), stdio: "inherit" });

  run("node", ["server.ts"], {
    cwd: join(REPO, "screensy-rendezvous"),
    env: { ...process.env, SCREENSY_LEFT_GRACE_MS: "12000", SCREENSY_LOST_GRACE_MS: "60000" },
  });
  run(website, [], { cwd: join(REPO, "screensy-website") });
  startProxy();
  run(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "screensy-e2e-"))}`,
    "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
  ]);
  await waitHttp(`${ORIGIN}/`);
  const version = await (await waitHttp(`http://localhost:${CDP_PORT}/json/version`)).json();
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.open;
  console.log(`Chrome ${version.Browser}`);

  // Language selection
  await step("Accept-Language selects ja or en", async () => {
    const html = async (lang) =>
      (await (await fetch(`${ORIGIN}/`, { headers: { "Accept-Language": lang } })).text()).match(
        /<html lang="(\w+)"/,
      )[1];
    assert.equal(await html("ja,en;q=0.8"), "ja");
    assert.equal(await html("ja-JP"), "ja");
    assert.equal(await html("en-US"), "en");
    assert.equal(await html("fr-FR,de;q=0.9"), "en");
    const r = await fetch(`${ORIGIN}/screensy.js`);
    assert.equal(r.headers.get("cache-control"), "no-cache");
  });

  const a = await newPage(cdp, "A");
  const b = await newPage(cdp, "B", { acceptLanguage: "ja" });
  let room;
  let a2Target;

  await step("creator opens / and gets the start dialog", async () => {
    await a.goto(`${ORIGIN}/`);
    const s = await a.waitFor("start dialog", (s) => s.dialogOpen && s.dialogMode === "start");
    assert.match(s.hash, /^#[A-Z][a-zA-Z]+$/);
    assert.equal(s.replaceOptions, null);
    room = s.hash;
    await a.shot("1-start-dialog-en");
  });

  await step("creator starts presenting", async () => {
    await a.submitDialog("Alice");
    const s = await a.waitFor("presenting", (s) => s.videoLocal && s.toolbar.includes("stop-button"));
    assert.ok(!s.toolbar.includes("present-button"));
    assert.equal(s.status, null);
    assert.equal(s.viewers, "0");
    await a.shot("2-presenting-en");
  });

  await step("viewer (ja) joins and receives the stream", async () => {
    await b.goto(`${ORIGIN}/${room}`);
    const s = await b.waitFor("video", (s) => s.videoPlaying);
    assert.equal(s.lang, "ja");
    assert.equal(s.status, null);
    assert.deepEqual(s.toolbar, ["present-button", "menu-button"]);
    await a.waitFor("viewer count 1", (s) => s.viewers === "1");
    await b.shot("3-viewing-ja");
    await a.shot("3b-presenting-1-viewer-en");
  });

  await step("viewer takes over after the confirmation dialog", async () => {
    await b.click("#present-button");
    const s = await b.waitFor("takeover dialog", (s) => s.dialogOpen);
    assert.deepEqual(s.replaceOptions, [{ name: "Alice", checked: true }]);
    await b.shot("4-takeover-dialog-ja");
    await b.submitDialog("Bob");
    await b.waitFor("B presenting", (s) => s.videoLocal && s.toolbar.includes("stop-button"));
    const sa = await a.waitFor(
      "A notified and viewing B",
      (s) => s.notices.includes("notice-taken-over") && s.videoPlaying,
    );
    assert.match(sa.noticeText[0], /Bob/);
    assert.equal(sa.captureLive, false);
    await a.shot("5-taken-over-notice-en");
    assert.deepEqual(sa.toolbar, ["present-button", "menu-button"]);
  });

  await step("browser 'Stop sharing' (track ended) stops presenting", async () => {
    await b.eval(`window.__captures.at(-1).getVideoTracks()[0].dispatchEvent(new Event("ended"))`);
    await b.waitFor(
      "B stopped",
      (s) => !s.videoLocal && s.toolbar.includes("present-button") && s.status === "status-waiting",
    );
    await b.shot("6-waiting-ja");
    await a.waitFor("A waiting", (s) => s.status === "status-waiting");
  });

  await step("stop button stops presenting", async () => {
    await a.click("#present-button");
    const s = await a.waitFor("dialog with stored name", (s) => s.dialogOpen);
    assert.equal(s.nameValue, "Alice", "name remembered");
    assert.equal(s.replaceOptions, null);
    await a.submitDialog("Alice");
    await b.waitFor("B viewing A", (s) => s.videoPlaying);
    await a.click("#stop-button");
    await a.waitFor("A stopped", (s) => !s.videoLocal && s.status === "status-waiting");
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
  });

  await step("denied capture shows a dismissible notice and changes nothing", async () => {
    await a.eval("window.__denyCapture = true");
    await a.click("#present-button");
    await a.waitFor("dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    const s = await a.waitFor("notice", (s) => s.notices.includes("notice-access-denied"));
    assert.equal(s.videoLocal, false);
    await a.click("#notice-access-denied .notice-close");
    await a.waitFor("notice closed", (s) => s.notices.length === 0);
    await a.eval("window.__denyCapture = false");
  });

  await step("presenter reloads and resumes from the dialog", async () => {
    await a.click("#present-button");
    await a.waitFor("dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await b.waitFor("B viewing A", (s) => s.videoPlaying);
    await a.reload();
    const s = await a.waitFor("resume dialog", (s) => s.dialogOpen && s.dialogMode === "resume");
    assert.equal(s.nameValue, "Alice");
    const sb = await b.waitFor("B sees resuming", (s) => s.status === "status-presenter-resuming");
    assert.match(sb.statusText, /Alice/);
    await a.shot("7-resume-dialog-en");
    await b.shot("8-presenter-resuming-ja");
    await a.submitDialog("Alice");
    await a.waitFor("A presenting again", (s) => s.videoLocal);
    await b.waitFor("B viewing again", (s) => s.videoPlaying);
  });

  await step("WebSocket drop resumes without a click and keeps the capture", async () => {
    await a.eval("window.__sockets.at(-1).close()");
    await b
      .waitFor("B sees reconnecting or switching", (s) => !s.videoPlaying || s.status != null, 5000)
      .catch(() => {});
    const s = await a.waitFor(
      "A presenting after reconnect",
      (s) => s.videoLocal && s.captureLive && !s.dialogOpen,
      15000,
    );
    assert.equal(s.notices.length, 0);
    await b.waitFor("B viewing again", (s) => s.videoPlaying, 15000);
    assert.equal((await a.state()).captureLive, true);
  });

  await step("duplicated tab: both tabs view, original becomes a new participant", async () => {
    const token = await b.eval(`sessionStorage.getItem("screensy.resume." + location.hash.substring(1).toLowerCase())`);
    assert.ok(token);
    const key = `screensy.resume.${room.substring(1).toLowerCase()}`;
    const b2 = await newPageInContext(cdp, "B2", b.browserContextId, {
      acceptLanguage: "ja",
      initExtra: `try { if (!sessionStorage.getItem(${JSON.stringify(key)})) sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(token)}); } catch {}`,
    });
    await b2.goto(`${ORIGIN}/${room}`);
    await b2.waitFor("B2 viewing", (s) => s.videoPlaying, 15000);
    await b.waitFor("B viewing again as new participant", (s) => s.videoPlaying, 15000);
    const newToken = await b.eval(
      `sessionStorage.getItem("screensy.resume." + location.hash.substring(1).toLowerCase())`,
    );
    assert.notEqual(newToken, token);
    await a.waitFor("A counts 2 viewers", (s) => s.viewers === "2");
    await cdp.send("Target.closeTarget", { targetId: b2.targetId });
    await a.waitFor("A counts 1 viewer", (s) => s.viewers === "1");
  });

  await step("takeover while the presenter is reloading closes their resume dialog", async () => {
    await a.reload();
    await a.waitFor("resume dialog", (s) => s.dialogOpen && s.dialogMode === "resume");
    await b.waitFor("B sees resuming", (s) => s.status === "status-presenter-resuming");
    await b.click("#present-button");
    const sb = await b.waitFor("B dialog", (s) => s.dialogOpen);
    assert.deepEqual(sb.replaceOptions, [{ name: "Alice", checked: true }]);
    await b.submitDialog("Bob");
    await b.waitFor("B presenting", (s) => s.videoLocal);
    const sa = await a.waitFor(
      "A dialog closed and notified",
      (s) => !s.dialogOpen && s.notices.includes("notice-taken-over"),
    );
    assert.match(sa.noticeText[0], /Bob/);
    await a.waitFor("A viewing B", (s) => s.videoPlaying);
  });

  await step("cancelling the resume dialog frees the seat", async () => {
    await b.reload();
    await b.waitFor("resume dialog", (s) => s.dialogOpen && s.dialogMode === "resume");
    await b.click("#present-cancel");
    await a.waitFor("A waiting", (s) => s.status === "status-waiting");
    const s = await b.state();
    assert.equal(s.status, "status-waiting");
    assert.deepEqual(s.toolbar, ["present-button", "menu-button"]);
  });

  await step("duplicated presenter tab: the seat moves to the duplicate, the original stops", async () => {
    await a.eval(`document.querySelectorAll(".notice:not(.hidden) .notice-close").forEach((b) => b.click())`);
    await a.click("#present-button");
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal && s.captureLive);
    await b.waitFor("B viewing A", (s) => s.videoPlaying);

    const key = `screensy.resume.${room.substring(1).toLowerCase()}`;
    const token = await a.eval(`sessionStorage.getItem(${JSON.stringify(key)})`);
    assert.ok(token);
    // Duplicating a tab copies its sessionStorage, and with it the resume token
    const a2 = await newPageInContext(cdp, "A2", a.browserContextId, {
      initExtra: `try { if (!sessionStorage.getItem(${JSON.stringify(key)})) sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(token)}); } catch {}`,
    });
    await a2.goto(`${ORIGIN}/${room}`);

    const s2 = await a2.waitFor("A2 resume dialog", (s) => s.dialogOpen && s.dialogMode === "resume", 15000);
    assert.equal(s2.nameValue, "Alice");
    const sa = await a.waitFor(
      "A stopped and notified",
      (s) => !s.videoLocal && !s.captureLive && s.notices.length > 0,
      15000,
    );
    assert.deepEqual(sa.notices, ["notice-moved-to-other-tab"]);
    assert.equal(sa.noticeText[0], "Your presentation moved to another tab, so this tab stopped presenting.");
    assert.notEqual(await a.eval(`sessionStorage.getItem(${JSON.stringify(key)})`), token);
    const sb = await b.waitFor("B sees resuming", (s) => s.status === "status-presenter-resuming");
    assert.match(sb.statusText, /Alice/);
    await a.shot("9-original-after-duplicate-en");

    await a2.submitDialog("Alice");
    await a2.waitFor("A2 presenting", (s) => s.videoLocal && s.captureLive);
    await b.waitFor("B viewing A2", (s) => s.videoPlaying, 15000);
    await a.waitFor("A viewing A2", (s) => s.videoPlaying, 15000);
    await a2.waitFor("A2 counts 2 viewers", (s) => s.viewers === "2");
    assert.equal((await a.state()).captureLive, false);
    a2Target = a2.targetId;
  });

  await step(
    "closed presenter tab: 'left the page' with a countdown of the short grace period, then waiting",
    async () => {
      await cdp.send("Target.closeTarget", { targetId: a2Target });
      const sb = await b.waitFor("B sees left", (s) => s.status === "status-presenter-left");
      assert.match(sb.statusText, /^Aliceさんがページを離れました。戻ってくるのを待っています…（あと 0:1\d）$/);
      const sa = await a.waitFor("A sees left", (s) => s.status === "status-presenter-left");
      assert.match(sa.statusText, /^Alice left the page\. Waiting for them to come back… \(0:1\d left\)$/);
      await b.shot("10-presenter-left-ja");
      await a.shot("11-presenter-left-en");
      const first = sb.statusText;
      await sleep(2100);
      assert.notEqual((await b.state()).statusText, first, "the countdown moves");
      await b.waitFor("B waiting after the grace period", (s) => s.status === "status-waiting", 15000);
      await a.waitFor("A waiting after the grace period", (s) => s.status === "status-waiting");
    },
  );

  await step(
    "broken presenter connection: 'connection was lost' with the long grace period, then auto-resume",
    async () => {
      // Tag A's next WebSocket, then reconnect it so that the tag applies
      await a.eval(`document.cookie = "e2e=a; path=/"`);
      const socketCount = await a.eval("window.__sockets.length");
      await a.eval("window.__sockets.at(-1).close()");
      const end = Date.now() + 15000;
      while (!(await a.eval(`window.__sockets.length > ${socketCount} && window.__sockets.at(-1).readyState === 1`))) {
        if (Date.now() > end) throw new Error("A did not reconnect");
        await sleep(100);
      }
      await a.waitFor("A reconnected", (s) => s.toolbar.includes("present-button"), 15000);
      await a.click("#present-button");
      await a.waitFor("A dialog", (s) => s.dialogOpen);
      await a.submitDialog("Alice");
      await a.waitFor("A presenting", (s) => s.videoLocal && s.captureLive);
      await b.waitFor("B viewing A", (s) => s.videoPlaying, 15000);

      proxyBlocked.add("a");
      dropSockets("a");
      const sb = await b.waitFor("B sees lost", (s) => s.status === "status-presenter-lost");
      assert.match(sb.statusText, /^Aliceさんの接続が切れました。再接続を待っています…（あと (1:00|0:5\d)）$/);
      const sa = await a.waitFor("A sees the server reconnecting", (s) => s.status === "status-server-reconnecting");
      assert.equal(sa.captureLive, true);
      await b.shot("12-presenter-lost-ja");

      proxyBlocked.delete("a");
      await a.waitFor("A presenting again", (s) => s.status == null && s.videoLocal && s.captureLive, 20000);
      await b.waitFor("B viewing A again", (s) => s.videoPlaying, 15000);
    },
  );

  // --- Switching and hiding the screen ---

  const isRed = (c) => c != null && c.r > 180 && c.g < 80 && c.b < 80;
  const isBlue = (c) => c != null && c.b > 180 && c.r < 80 && c.g < 80;
  const isGreen = (c) => c != null && c.g > 100 && c.r < 80 && c.b < 80;
  const isYellow = (c) => c != null && c.r > 180 && c.g > 180 && c.b < 80;
  const isBlack = (c) => c != null && c.r < 20 && c.g < 20 && c.b < 20;
  const openSenders = (kind) =>
    `window.__pcs.filter((pc) => pc.connectionState !== "closed").flatMap((pc) => pc.getSenders()).filter((s) => s.track?.kind === ${JSON.stringify(kind)})`;
  const switchTo = async (page, capture) => {
    await page.eval(`window.__nextCapture = ${JSON.stringify(capture)}`);
    await page.click("#switch-button");
  };
  let c;
  let d;

  await step("switching the screen keeps the connections and the stream", async () => {
    const pcs = await b.eval("window.__pcs.length");
    const streamId = await b.eval("window.__roomState.presenters[0].streamId");
    const oldTrack = await a.eval("window.__captures.length - 1");
    await switchTo(a, { width: 800, height: 600, color: "rgb(255, 0, 0)" });
    await waitColor(b, "B sees the red 800x600 screen", (c) => isRed(c) && c.width === 800 && c.height === 600);
    assert.equal(await b.eval("window.__pcs.length"), pcs, "no new connection on the viewer");
    assert.equal(await b.eval("window.__roomState.presenters[0].streamId"), streamId);
    assert.equal(await a.eval(`window.__captures[${oldTrack}].getVideoTracks()[0].readyState`), "ended");
    const sa = await a.waitFor("A shows the new capture", (s) => s.videoLocal && s.captureLive);
    assert.ok(sa.toolbar.includes("switch-button"));
  });

  await step("a cancelled switch keeps the current screen", async () => {
    await a.eval("window.__denyCapture = true");
    await a.click("#switch-button");
    await sleep(500);
    await a.eval("window.__denyCapture = false");
    const sa = await a.state();
    assert.ok(sa.videoLocal && sa.captureLive);
    assert.equal(sa.notices.length, 0);
    assert.equal(await a.eval(`document.getElementById("switch-button").disabled`), false);
    await waitColor(b, "B still sees red", isRed);
  });

  await step("hiding the screen: black and silent for the viewers and in the presenter's preview", async () => {
    await a.click("#hide-button");
    const sb = await b.waitFor("B sees hidden", (s) => s.status === "status-presenter-hidden");
    assert.equal(sb.statusText, "Aliceさんが画面を一時的に隠しています。");
    await waitColor(b, "B sees black", isBlack);
    const sa = await a.waitFor("A sees self hidden", (s) => s.status === "status-self-hidden");
    assert.ok(sa.toolbar.includes("show-button") && !sa.toolbar.includes("hide-button"));
    await waitColor(a, "A's preview is black too", isBlack);
    assert.equal(await a.eval(`${openSenders("video")}.every((s) => !s.track.enabled)`), true);
    await b.shot("13-presenter-hidden-ja");
    await a.shot("14-self-hidden-en");

    c = await newPage(cdp, "C");
    await c.goto(`${ORIGIN}/${room}`);
    const sc = await c.waitFor("C, joining later, sees hidden", (s) => s.status === "status-presenter-hidden", 15000);
    assert.match(sc.statusText, /^Alice has hidden their screen/);
  });

  await step("switching while hidden never sends the new screen or audio", async () => {
    await a.eval("window.__replaced = []");
    await switchTo(a, { width: 640, height: 480, color: "rgb(0, 0, 255)", audio: true });
    await a.waitFor("A shows the blue capture", (s) => s.videoLocal && s.captureLive);
    await waitColor(a, "A's preview of the new capture is black", isBlack);
    const replaced = await a.eval("window.__replaced.filter((r) => r.kind != null)");
    assert.equal(replaced.length, 4, "video and audio for B and C");
    assert.ok(
      replaced.every((r) => r.enabled === false),
      JSON.stringify(replaced),
    );
    await sleep(1000);
    await waitColor(b, "B still sees black", isBlack);
    assert.equal((await b.state()).status, "status-presenter-hidden");
    assert.equal(await a.eval(`${openSenders("audio")}.every((s) => !s.track.enabled)`), true);
  });

  await step("showing the screen again, now with audio that the first screen did not have", async () => {
    await a.click("#show-button");
    await waitColor(b, "B sees blue", (c) => isBlue(c) && c.width === 640 && c.height === 480);
    await waitColor(c, "C sees blue", isBlue);
    await b.waitFor("B status cleared", (s) => s.status == null);
    await a.waitFor("A status cleared", (s) => s.status == null && s.toolbar.includes("hide-button"));
    const end = Date.now() + 10000;
    while (!(await b.eval(`document.getElementById("stream").srcObject?.getAudioTracks()[0]?.muted === false`))) {
      if (Date.now() > end) throw new Error("B gets no audio");
      await sleep(200);
    }
    // The audio senders had no track before the switch, and now get their bitrate limit
    assert.equal(
      await a.eval(`${openSenders("audio")}.every((s) => s.getParameters().encodings[0]?.maxBitrate === 960000)`),
      true,
    );
  });

  await step("a hidden screen stays hidden after an automatic resume", async () => {
    await a.click("#hide-button");
    await b.waitFor("B sees hidden", (s) => s.status === "status-presenter-hidden");
    const streamId = await b.eval("window.__roomState.presenters[0].streamId");
    await a.eval("window.__sockets.at(-1).close()");
    const end = Date.now() + 20000;
    while (
      !(await b.eval(
        `window.__roomState.presenters[0]?.streamId !== ${JSON.stringify(streamId)} && window.__roomState.presenters[0]?.status === "live" && window.__roomState.presenters[0]?.hidden === true`,
      ))
    ) {
      if (Date.now() > end) throw new Error("the resumed stream is not hidden");
      await sleep(200);
    }
    await b.waitFor("B sees hidden again", (s) => s.status === "status-presenter-hidden", 15000);
    await waitColor(b, "B sees black", isBlack, 15000);
    await a.waitFor("A still hidden", (s) => s.status === "status-self-hidden" && s.captureLive);
    await a.click("#show-button");
    await waitColor(b, "B sees blue again", isBlue);
  });

  await step("a switch that one connection rejects goes back to the current screen everywhere", async () => {
    await a.eval(`(() => {
      const open = window.__pcs.filter((pc) => pc.connectionState !== "closed");
      const victim = open.at(-1);
      window.__replaceHook = async (sender, track) => {
        if (sender.__pc === victim && track != null && track !== sender.track) throw new Error("injected failure");
      };
    })()`);
    await switchTo(a, { width: 1024, height: 576, color: "rgb(0, 160, 0)" });
    const sa = await a.waitFor("A notified", (s) => s.notices.includes("notice-switch-failed"));
    assert.match(sa.noticeText.join(" "), /Could not switch to that screen/);
    await a.eval("window.__replaceHook = null");
    assert.equal(
      await a.eval("window.__captures.at(-1).getVideoTracks()[0].readyState"),
      "ended",
      "new capture stopped",
    );
    assert.equal(await a.eval(`${openSenders("video")}.every((s) => s.track.readyState === "live")`), true);
    await waitColor(a, "A's preview stays blue", isBlue);
    await sleep(1000);
    for (const viewer of [b, c]) {
      const color = await viewer.eval(VIDEO_COLOR);
      assert.ok(isBlue(color) && !isGreen(color), `${viewer.label}: ${JSON.stringify(color)}`);
    }
    // Forget the rejected capture, so that the page state looks at the current one again
    await a.eval("window.__captures.pop()");
    await a.click("#notice-switch-failed .notice-close");
  });

  await step("a viewer who joins during a switch gets the new screen", async () => {
    await a.eval(`(() => {
      window.__gate = new Promise((resolve) => (window.__openGate = resolve));
      window.__replaceHook = () => window.__gate;
    })()`);
    const pcs = await a.eval("window.__pcs.length");
    await switchTo(a, { width: 1280, height: 720, color: "rgb(255, 255, 0)" });
    assert.equal(await a.eval(`document.getElementById("switch-button").disabled`), true);
    d = await newPage(cdp, "D");
    await d.goto(`${ORIGIN}/${room}`);
    const end = Date.now() + 15000;
    while ((await a.eval("window.__pcs.length")) <= pcs) {
      if (Date.now() > end) throw new Error("A did not open a connection to D");
      await sleep(100);
    }
    await a.eval("window.__openGate(); window.__replaceHook = null");
    for (const viewer of [b, c]) {
      await waitColor(viewer, `${viewer.label} sees yellow`, (c) => isYellow(c) && c.width === 1280, 15000);
    }
    // D's connection is new, so it may still be ramping up its resolution
    await waitColor(d, "D sees yellow", isYellow, 15000);
    assert.equal(await a.eval(`${openSenders("video")}.length`), 3, "one video sender per viewer");
    await a.waitFor("switch button enabled", (s) => s.toolbar.includes("switch-button"));
    assert.equal(await a.eval(`document.getElementById("switch-button").disabled`), false);
  });

  await step("'Stop sharing' on a switched screen stops presenting", async () => {
    await a.eval(`window.__captures.at(-1).getVideoTracks()[0].dispatchEvent(new Event("ended"))`);
    await a.waitFor("A stopped", (s) => !s.toolbar.includes("stop-button") && s.toolbar.includes("present-button"));
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
    for (const page of [c, d]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
  });

  // --- Menu and quality settings ---

  const MENU_VALUES = `({
    frameRate: document.getElementById("quality-frame-rate").value,
    resolution: document.getElementById("quality-resolution").value,
    bitrate: document.getElementById("quality-bitrate").value,
    degradation: document.getElementById("quality-degradation").value,
  })`;
  const setInput = (page, id, value) =>
    page.eval(`(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event("change"));
    })()`);
  const videoParameters = `${openSenders("video")}.map((s) => {
    const p = s.getParameters();
    return { ...p.encodings[0], degradationPreference: p.degradationPreference, contentHint: s.track.contentHint };
  })`;
  async function waitEval(page, desc, expression, predicate, timeout = 10000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await page.eval(expression);
      if (predicate(last)) return last;
      await sleep(200);
    }
    throw new Error(`${page.label}: timeout waiting for ${desc}\nlast: ${JSON.stringify(last)}`);
  }

  await step("the menu opens and shows the default quality settings", async () => {
    const sa = await a.state();
    assert.ok(sa.toolbar.includes("menu-button"));
    await a.click("#menu-button");
    assert.equal(await a.eval(`document.getElementById("menu").matches(":popover-open")`), true);
    assert.deepEqual(await a.eval(MENU_VALUES), {
      frameRate: "30",
      resolution: "",
      bitrate: "100",
      degradation: "maintain-resolution",
    });
    await a.shot("15-menu-en");
    await a.eval(`document.getElementById("menu").hidePopover()`);
  });

  await step("quality settings chosen before presenting apply when presenting", async () => {
    await setInput(a, "quality-frame-rate", "60");
    await setInput(a, "quality-resolution", "720");
    await setInput(a, "quality-bitrate", "5");
    await setInput(a, "quality-degradation", "maintain-framerate");
    assert.deepEqual(JSON.parse(await a.eval(`localStorage.getItem("screensy.quality")`)), {
      frameRate: 60,
      maxHeight: 720,
      maxBitrateMbps: 5,
      degradation: "maintain-framerate",
    });

    await a.click("#present-button");
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.eval("window.__nextCapture = { width: 1920, height: 1080, frameRate: 60 }");
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal && s.captureLive);
    assert.equal(await a.eval("window.__displayOptions.video.frameRate.ideal"), 60);
    await b.waitFor("B viewing", (s) => s.videoPlaying, 15000);

    const [parameters] = await waitEval(
      a,
      "the quality on the sender",
      videoParameters,
      (list) => list[0]?.maxFramerate === 60,
    );
    console.log(`     sender: ${JSON.stringify(parameters)}`);
    assert.equal(parameters.maxBitrate, 5_000_000);
    assert.equal(parameters.scaleResolutionDownBy, 1.5);
    assert.equal(parameters.contentHint, "motion");
    assert.ok([undefined, "maintain-framerate"].includes(parameters.degradationPreference));
    await waitColor(b, "B gets at most 720p", (c) => c != null && c.height > 0 && c.height <= 720);
  });

  await step("changes while presenting apply to every connection, and to viewers who join later", async () => {
    await setInput(a, "quality-frame-rate", "30");
    await setInput(a, "quality-resolution", "360");
    await setInput(a, "quality-bitrate", "2");
    await waitEval(
      a,
      "360p on B's sender",
      videoParameters,
      (list) => list.length === 1 && list[0].scaleResolutionDownBy === 3,
    );
    c = await newPage(cdp, "C");
    await c.goto(`${ORIGIN}/${room}`);
    await c.waitFor("C viewing", (s) => s.videoPlaying, 15000);
    const list = await waitEval(
      a,
      "the same quality for C",
      videoParameters,
      (list) => list.length === 2 && list.every((p) => p.scaleResolutionDownBy === 3 && p.maxBitrate === 2_000_000),
    );
    assert.ok(list.every((p) => p.maxFramerate === 30));
    await waitColor(b, "B gets at most 360p", (c) => c != null && c.height > 0 && c.height <= 360);

    // The capture runs at 60 fps; the senders keep to 30
    await sleep(4000);
    const fps = await a.eval(`(async () => {
      const values = [];
      for (const pc of window.__pcs.filter((pc) => pc.connectionState !== "closed")) {
        (await pc.getStats()).forEach((r) => { if (r.type === "outbound-rtp" && r.kind === "video") values.push(r.framesPerSecond ?? 0); });
      }
      return values;
    })()`);
    console.log(`     framesPerSecond: ${JSON.stringify(fps)}`);
    assert.ok(fps.length === 2 && fps.every((value) => value <= 33), "at most about 30 fps");
  });

  await step("an invalid value is not applied and the input goes back", async () => {
    await setInput(a, "quality-frame-rate", "0");
    await setInput(a, "quality-bitrate", "1000");
    assert.deepEqual(await a.eval(MENU_VALUES), {
      frameRate: "30",
      resolution: "360",
      bitrate: "2",
      degradation: "maintain-framerate",
    });
    await sleep(500);
    const list = await a.eval(videoParameters);
    assert.ok(list.every((p) => p.maxFramerate === 30 && p.maxBitrate === 2_000_000));
    assert.equal(JSON.parse(await a.eval(`localStorage.getItem("screensy.quality")`)).frameRate, 30);
  });

  await step("the browser remembers the settings, and invalid stored values fall back to the defaults", async () => {
    const a3 = await newPageInContext(cdp, "A3", a.browserContextId);
    await a3.goto(`${ORIGIN}/${room}`);
    assert.deepEqual(await a3.eval(MENU_VALUES), {
      frameRate: "30",
      resolution: "360",
      bitrate: "2",
      degradation: "maintain-framerate",
    });
    await a3.eval(
      `localStorage.setItem("screensy.quality", JSON.stringify({ frameRate: 45, maxHeight: 720, degradation: "fast" }))`,
    );
    await a3.reload();
    assert.deepEqual(await a3.eval(MENU_VALUES), {
      frameRate: "30",
      resolution: "720",
      bitrate: "100",
      degradation: "maintain-resolution",
    });
    await a3.eval(`localStorage.setItem("screensy.quality", "{broken")`);
    await a3.reload();
    assert.deepEqual(await a3.eval(MENU_VALUES), {
      frameRate: "30",
      resolution: "",
      bitrate: "100",
      degradation: "maintain-resolution",
    });
    for (const page of [a3, c]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
    await a.click("#stop-button");
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
  });

  // --- Menu: link, name, participants ---

  const isShown = (id) => `!document.getElementById(${JSON.stringify(id)}).classList.contains("hidden")`;
  const PARTICIPANTS = `({
    count: document.querySelector("#menu-participants .count-slot").textContent,
    list: [...document.querySelectorAll("#participant-list li")].map((li) => ({
      name: li.querySelector(".participant-name").textContent,
      badges: [...li.querySelectorAll(".badge")].map((badge) => badge.textContent),
    })),
  })`;
  let e;

  await step("everyone gets the menu; without screen sharing, it has no quality section", async () => {
    assert.ok((await b.state()).toolbar.includes("menu-button"));
    assert.equal(await b.eval(isShown("menu-quality")), true);
    e = await newPage(cdp, "E", {
      initExtra: "delete navigator.mediaDevices.getDisplayMedia; delete MediaDevices.prototype.getDisplayMedia;",
    });
    await e.goto(`${ORIGIN}/${room}`);
    const se = await e.waitFor("E joined", (s) => s.status === "status-waiting");
    assert.deepEqual(se.toolbar, ["menu-button"]);
    assert.equal(await e.eval(isShown("menu-quality")), false);
  });

  await step("the link of the room can be copied", async () => {
    assert.equal(await b.eval(`document.getElementById("room-link").value === location.href`), true);
    await cdp.send("Browser.grantPermissions", {
      origin: ORIGIN,
      browserContextId: b.browserContextId,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await b.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await b.click("#menu-button");
    await b.click("#copy-link-button");
    await waitEval(b, "copied", isShown("copy-link-done"), (shown) => shown === true);
    assert.equal(await b.eval("navigator.clipboard.readText().then((text) => text === location.href)"), true);
    await b.shot("16-menu-ja");

    // Without the clipboard, the link is selected for copying by hand
    await b.eval(`navigator.clipboard.writeText = () => Promise.reject(new Error("blocked"))`);
    await b.click("#copy-link-button");
    await waitEval(b, "copy failed", isShown("copy-link-failed"), (shown) => shown === true);
    assert.equal(await b.eval(isShown("copy-link-done")), false);
    assert.equal(
      await b.eval(`(() => {
        const input = document.getElementById("room-link");
        return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
      })()`),
      true,
    );
    await b.eval(`document.getElementById("menu").hidePopover()`);
  });

  await step("a viewer sets their name in the menu; everyone sees it, and the browser remembers it", async () => {
    await setInput(b, "menu-name-input", "  Bobby  ");
    await waitEval(a, "Bobby in A's list", PARTICIPANTS, (p) => p.list.some((entry) => entry.name === "Bobby"));
    await waitEval(
      b,
      "the trimmed name in B's input",
      `document.getElementById("menu-name-input").value`,
      (v) => v === "Bobby",
    );
    assert.equal(await b.eval(`localStorage.getItem("screensy.name")`), "Bobby");

    await b.reload();
    await waitEval(a, "Bobby after B's reload", PARTICIPANTS, (p) => p.list.some((entry) => entry.name === "Bobby"));
    assert.equal(await b.eval(`document.getElementById("menu-name-input").value`), "Bobby");
    await b.click("#present-button");
    const sb = await b.waitFor("B dialog", (s) => s.dialogOpen);
    assert.equal(sb.nameValue, "Bobby");
    await b.click("#present-cancel");
  });

  await step("the participant list shows who presents, who you are, and who is reconnecting", async () => {
    await a.click("#present-button");
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal);
    // E has no name: a guest numbered by its participant ID
    const guestId = await b.eval(`window.__roomState.participants.find((p) => p.name === "").id`);
    const expected = {
      count: "3",
      list: [
        { name: "Alice", badges: ["配信中"] },
        { name: "Bobby", badges: ["あなた"] },
        { name: `ゲスト ${Number(guestId) + 1}`, badges: [] },
      ],
    };
    await waitEval(b, "B's list", PARTICIPANTS, (p) => JSON.stringify(p) === JSON.stringify(expected));
    const sa = await waitEval(a, "A's list", PARTICIPANTS, (p) => p.list[0]?.badges.length === 2);
    assert.deepEqual(sa.list[0], { name: "Alice", badges: ["presenting", "you"] });

    await a.reload();
    await a.waitFor("resume dialog", (s) => s.dialogOpen && s.dialogMode === "resume");
    await waitEval(b, "Alice reconnecting", PARTICIPANTS, (p) => p.list[0]?.badges[0] === "再接続待ち");
    await a.click("#present-cancel");
    await waitEval(b, "Alice viewing", PARTICIPANTS, (p) => p.list.every((entry) => !entry.badges.includes("配信中")));
    await cdp.send("Target.closeTarget", { targetId: e.targetId });
    await waitEval(b, "two left", PARTICIPANTS, (p) => p.count === "2");
  });

  // --- Menu: connection statistics ---

  const STATS = `({
    empty: !document.getElementById("stats-empty").classList.contains("hidden"),
    entries: [...document.querySelectorAll("#stats-list .stats-entry")].map((entry) => ({
      name: entry.querySelector(".stats-name").textContent,
      fields: Object.fromEntries(
        [...entry.querySelectorAll("dd[data-field]")]
          .filter((dd) => !dd.classList.contains("hidden"))
          .map((dd) => [dd.dataset.field, dd.textContent]),
      ),
    })),
  })`;
  const openMenu = (page) => page.eval(`document.getElementById("menu").showPopover()`);
  const closeMenu = (page) => page.eval(`document.getElementById("menu").hidePopover()`);
  const filled = (fields) => fields.bitrate !== "—" && fields.roundTripTime !== "—" && fields.resolution !== "—";

  await step("a viewer sees the statistics of the stream they receive", async () => {
    await a.click("#present-button");
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal);
    await b.waitFor("B viewing", (s) => s.videoPlaying, 15000);
    await openMenu(b);
    const stats = await waitEval(
      b,
      "B's statistics",
      STATS,
      (s) => s.entries.length === 1 && filled(s.entries[0].fields),
      15000,
    );
    const { name, fields } = stats.entries[0];
    console.log(`     viewer: ${JSON.stringify(fields)}`);
    assert.equal(stats.empty, false);
    assert.equal(name, "Alice");
    assert.equal(fields.state, "接続済み");
    assert.equal(fields.route, "直接");
    assert.match(fields.video, /^[A-Za-z0-9]+$/);
    assert.equal(fields.resolution, "640×360");
    assert.match(fields.frameRate, /^\d+ fps$/);
    assert.match(fields.bitrate, /^[\d.]+ (k|M)bps$/);
    assert.match(fields.roundTripTime, /^\d+ ms$/);
    assert.match(fields.packetLoss, /^\d+\.\d%$/);
    assert.equal(fields.audio, "—", "the capture has no audio");
    assert.equal("limitation" in fields, false, "no limitation for a received stream");
    await b.shot("17-stats-viewer-ja");
  });

  await step("the presenter sees the statistics per viewer, which follow the viewers", async () => {
    await openMenu(a);
    const stats = await waitEval(
      a,
      "A's statistics",
      STATS,
      (s) => s.entries.length === 1 && filled(s.entries[0].fields),
      15000,
    );
    const { name, fields } = stats.entries[0];
    console.log(`     presenter: ${JSON.stringify(fields)}`);
    assert.equal(name, "Bobby");
    assert.equal(fields.state, "Connected");
    assert.equal(fields.route, "Direct");
    assert.equal(fields.resolution, "640×360");
    assert.equal(fields.audio, "—", "no audio is sent");
    assert.ok(["Nothing", "Bandwidth", "CPU", "Other"].includes(fields.limitation), fields.limitation);

    c = await newPage(cdp, "C");
    await c.goto(`${ORIGIN}/${room}`);
    await c.waitFor("C viewing", (s) => s.videoPlaying, 15000);
    const two = await waitEval(a, "two viewers", STATS, (s) => s.entries.length === 2);
    assert.ok(
      two.entries.some((entry) => /^Guest \d+$/.test(entry.name)),
      JSON.stringify(two.entries.map((e) => e.name)),
    );
    await a.shot("18-stats-presenter-en");
    await cdp.send("Target.closeTarget", { targetId: c.targetId });
    await waitEval(a, "one viewer again", STATS, (s) => s.entries.length === 1);
  });

  await step("the statistics are only collected while the menu is open", async () => {
    await closeMenu(a);
    await closeMenu(b);
    await sleep(300);
    const before = [await a.eval("window.__getStatsCalls"), await b.eval("window.__getStatsCalls")];
    await sleep(2500);
    const after = [await a.eval("window.__getStatsCalls"), await b.eval("window.__getStatsCalls")];
    assert.deepEqual(after, before);
    await openMenu(b);
    await sleep(2500);
    assert.ok((await b.eval("window.__getStatsCalls")) >= before[1] + 2, "collects again when opened");
  });

  await step("without a stream, the menu says that there are no statistics", async () => {
    await a.click("#stop-button");
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
    const stats = await waitEval(b, "no statistics", STATS, (s) => s.empty && s.entries.length === 0);
    assert.equal(stats.entries.length, 0);
    await closeMenu(b);
  });

  // --- Blur ---

  // The average difference between horizontal neighbors, drawn at 320x180: about 30 for the checkerboard, near 0 when
  // blurred
  const VIDEO_EDGES = `(() => {
    const video = document.getElementById("stream");
    if (video.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, 320, 180);
    const data = context.getImageData(0, 0, 320, 180).data;
    let sum = 0;
    let count = 0;
    for (let y = 0; y < 180; y++) {
      for (let x = 1; x < 320; x++) {
        const i = (y * 320 + x) * 4;
        sum += Math.abs(data[i] - data[i - 4]);
        count++;
      }
    }
    return { edges: sum / count, width: video.videoWidth, height: video.videoHeight };
  })()`;
  const isSharp = (v) => v != null && v.edges > 20;
  const isBlurry = (v) => v != null && v.edges < 5;
  const receivedFps = `(async () => {
    const values = [];
    for (const pc of window.__pcs.filter((pc) => pc.connectionState !== "closed")) {
      (await pc.getStats()).forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "video") values.push(r.framesPerSecond ?? 0); });
    }
    return values;
  })()`;
  const CHECKER = { width: 640, height: 360, pattern: "checker" };

  await step("blurring the screen: blurry for the viewers and in the preview, on the same connections", async () => {
    await a.eval(`window.__nextCapture = ${JSON.stringify(CHECKER)}`);
    await a.click("#present-button");
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal && s.toolbar.includes("blur-button"));
    const sharp = await waitEval(b, "B sees the sharp checkerboard", VIDEO_EDGES, isSharp, 15000);
    console.log(`     sharp: ${JSON.stringify(sharp)}`);
    const pcs = await b.eval("window.__pcs.length");
    const streamId = await b.eval("window.__roomState.presenters[0].streamId");

    const started = Date.now();
    await a.click("#blur-button");
    const blurry = await waitEval(b, "B sees it blurred", VIDEO_EDGES, isBlurry, 10000);
    console.log(`     blurred after ${Date.now() - started} ms: ${JSON.stringify(blurry)}`);
    assert.equal(blurry.width, 160, "sent at a quarter of the size");
    await waitEval(a, "A's preview is blurred too", VIDEO_EDGES, isBlurry);
    const sa = await a.state();
    assert.ok(sa.toolbar.includes("unblur-button") && !sa.toolbar.includes("blur-button"));
    assert.equal(await b.eval("window.__pcs.length"), pcs, "no new connection");
    assert.equal(await b.eval("window.__roomState.presenters[0].streamId"), streamId);
    await a.shot("19-blurred-en");

    await sleep(3000);
    const fps = await b.eval(receivedFps);
    console.log(`     received while blurred: ${JSON.stringify(fps)} fps`);
    assert.ok(fps.length === 1 && fps[0] >= 15, "at least 3/4 of the 20 fps capture");
  });

  await step("unblurring brings the sharp screen back", async () => {
    await a.click("#unblur-button");
    await waitEval(b, "B sees it sharp", VIDEO_EDGES, isSharp, 10000);
    await a.waitFor("blur button back", (s) => s.toolbar.includes("blur-button"));
  });

  await step("a switch while blurred only ever sends the blurred video", async () => {
    await a.click("#blur-button");
    await waitEval(b, "B sees it blurred", VIDEO_EDGES, isBlurry, 10000);
    await a.eval("window.__replaced = []");
    await switchTo(a, { width: 800, height: 600, pattern: "checker" });
    const blurry = await waitEval(
      b,
      "B sees the new screen blurred",
      VIDEO_EDGES,
      (v) => isBlurry(v) && v.width === 200,
      10000,
    );
    assert.equal(blurry.height, 150);
    const video = await a.eval(`window.__replaced.filter((r) => r.kind === "video")`);
    assert.ok(video.length > 0 && video.every((r) => r.type === "MediaStreamTrackGenerator"), JSON.stringify(video));
  });

  await step("hiding wins over the blur, and unblurring while hidden shows nothing", async () => {
    await a.click("#hide-button");
    await waitColor(b, "B sees black", isBlack);
    await a.eval("window.__replaced = []");
    await a.click("#unblur-button");
    await a.waitFor("A unblurred", (s) => s.toolbar.includes("blur-button"));
    const video = await a.eval(`window.__replaced.filter((r) => r.kind === "video")`);
    assert.ok(video.length > 0 && video.every((r) => r.enabled === false), JSON.stringify(video));
    await sleep(1000);
    await waitColor(b, "B still sees black", isBlack);
    await a.click("#show-button");
    await waitEval(b, "B sees the sharp screen", VIDEO_EDGES, isSharp, 10000);
  });

  await step("a blur that a connection rejects goes back and tells the presenter", async () => {
    await a.eval(`(() => {
      window.__replaceHook = async (sender, track) => {
        if (track != null && track.constructor.name === "MediaStreamTrackGenerator") throw new Error("injected failure");
      };
    })()`);
    await a.click("#blur-button");
    const sa = await a.waitFor("A notified", (s) => s.notices.includes("notice-blur-failed"));
    await a.eval("window.__replaceHook = null");
    assert.ok(sa.toolbar.includes("blur-button"), "still not blurred");
    await sleep(1000);
    assert.ok(isSharp(await b.eval(VIDEO_EDGES)), "B still sees the sharp screen");
    await a.click("#notice-blur-failed .notice-close");
  });

  await step("a blurred screen stays blurred after an automatic resume", async () => {
    await a.click("#blur-button");
    await waitEval(b, "B sees it blurred", VIDEO_EDGES, isBlurry, 10000);
    const streamId = await b.eval("window.__roomState.presenters[0].streamId");
    await a.eval("window.__sockets.at(-1).close()");
    const end = Date.now() + 20000;
    while (
      !(await b.eval(
        `window.__roomState.presenters[0]?.status === "live" && window.__roomState.presenters[0]?.streamId !== ${JSON.stringify(streamId)}`,
      ))
    ) {
      if (Date.now() > end) throw new Error("A did not resume");
      await sleep(200);
    }
    await b.waitFor("B viewing again", (s) => s.videoPlaying, 15000);
    await waitEval(b, "B sees it blurred again", VIDEO_EDGES, isBlurry, 10000);
    await a.click("#unblur-button");
    await a.click("#stop-button");
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
  });

  await step("without the breakout box, there is no blur button", async () => {
    const f = await newPage(cdp, "F", { initExtra: "delete window.MediaStreamTrackProcessor;" });
    await f.goto(`${ORIGIN}/`);
    await f.waitFor("F dialog", (s) => s.dialogOpen);
    await f.submitDialog("Frank");
    const sf = await f.waitFor("F presenting", (s) => s.videoLocal && s.toolbar.includes("hide-button"));
    assert.ok(!sf.toolbar.includes("blur-button") && !sf.toolbar.includes("unblur-button"));
    await cdp.send("Target.closeTarget", { targetId: f.targetId });
  });

  await step("a room that filled up while the dialog was open turns the new presenter away", async () => {
    const g = await newPage(cdp, "G");
    await g.goto(`${ORIGIN}/${room}`);
    await g.waitFor("G joined", (s) => s.status === "status-waiting");
    await g.click("#present-button");
    const sg = await g.waitFor("G dialog", (s) => s.dialogOpen);
    assert.equal(sg.replaceOptions, null, "nobody presents yet");

    await a.click("#present-button");
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal);

    await g.submitDialog("Gina");
    const sg2 = await g.waitFor("G notified", (s) => s.notices.includes("notice-full"));
    assert.equal(sg2.noticeText[0], "The room is full of presenters now. Try again.");
    assert.ok(!sg2.toolbar.includes("stop-button") && !sg2.captureLive);
    assert.ok((await a.state()).videoLocal, "A still presents");
    await b.waitFor("B viewing A", (s) => s.videoPlaying, 15000);
    await cdp.send("Target.closeTarget", { targetId: g.targetId });
    await a.click("#stop-button");
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
  });

  console.log(results.every(Boolean) ? "all passed" : "some failed");
}

main()
  .catch((e) => {
    if (!results.length || results.every(Boolean)) console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    setTimeout(() => process.exit(), 200);
  });
