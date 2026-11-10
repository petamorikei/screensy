// Browser checks for screensy: two or more headless Chrome pages in one room, driven over CDP with Node's built-in
// WebSocket. The script starts the rendezvous server, the website, a proxy that routes like the Caddyfile, and Chrome.
//
// Run it with `pnpm test:e2e`. It needs Go and Chrome, and the ports 4000, 8080, 8090, 8787 and 9333.
// - CHROME: the Chrome binary (default: the macOS install location)
// - SKIP_CLOUDFLARE: skip the last checks, which run screensy-cloudflare in `wrangler dev`
// - SHOTS: a directory to save screenshots of the UI into
// - DEBUG: print the output of the servers
//
// Chrome cannot accept the screen picker in headless mode, so getDisplayMedia returns a canvas stream instead. Chrome
// keeps its default mDNS host candidates, like a real browser.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const WRANGLER_PORT = 8787;
const ORIGIN = `http://localhost:${PROXY_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The selector of an element by its test ID: the pages name what the checks use with data-testid
const tid = (id) => `[data-testid="${id}"]`;

const children = [];
const run = (cmd, args, opts) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  child.detached = opts?.detached ?? false;
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  children.push(child);
  return child;
};
const cleanup = () => {
  for (const c of children) {
    // A detached child leads a process group: wrangler runs workerd as its own child
    try {
      if (c.detached) process.kill(-c.pid, "SIGKILL");
      else c.kill("SIGKILL");
    } catch {}
  }
};
process.on("exit", cleanup);

const proxySockets = new Map();
const proxyBlocked = new Set();

// Breaks the tagged WebSockets without a close frame, like a broken network. The server sees code 1006.
const dropSockets = (tag) => {
  for (const { socket, upstream } of proxySockets.get(tag) ?? []) {
    socket.destroy();
    upstream.destroy();
  }
  proxySockets.delete(tag);
};

// Same routing as the Caddyfile: WebSocket upgrades to 4000, everything else to 8080
const startProxy = () => {
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
};

const waitHttp = async (url, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
};

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
  // The first element, and every element, with a test ID
  window.$t = (id) => document.querySelector('[data-testid="' + id + '"]');
  window.$$t = (id) => [...document.querySelectorAll('[data-testid="' + id + '"]')];
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
    constructor(...args) {
      super(...args);
      window.__pcs.push(this);
    }
    addTransceiver(...args) { const transceiver = super.addTransceiver(...args); transceiver.sender.__pc = this; return transceiver; }
  };
  // How often the page reads the statistics
  window.__getStatsCalls = 0;
  const nativeGetStats = NativePeerConnection.prototype.getStats;
  // Methods, not arrow functions: they need the connection or the sender as this
  Object.assign(NativePeerConnection.prototype, {
    getStats(...args) { window.__getStatsCalls++; return nativeGetStats.apply(this, args); },
  });
  const nativeReplaceTrack = RTCRtpSender.prototype.replaceTrack;
  Object.assign(RTCRtpSender.prototype, {
    async replaceTrack(track) {
      window.__replaced.push({ kind: track?.kind ?? null, enabled: track?.enabled ?? null, type: track?.constructor.name ?? null });
      if (window.__replaceHook) await window.__replaceHook(this, track);
      return nativeReplaceTrack.call(this, track);
    },
  });

  // Drops the next live chat messages that the page sends on its data channels, like messages lost on the way:
  // __chatDropLive is how many sends (one per peer) to drop
  window.__chatDropLive = 0;
  const nativeChannelSend = RTCDataChannel.prototype.send;
  Object.assign(RTCDataChannel.prototype, {
    send(data) {
      if (window.__chatDropLive > 0 && typeof data === "string" && data.startsWith('{"type":"messages","live":true')) {
        window.__chatDropLive--;
        return;
      }
      return nativeChannelSend.call(this, data);
    },
  });

  // getUserMedia gets Chrome's fake microphone and camera (--use-fake-device-for-media-stream): a beep, and a moving
  // picture. An oscillator in an AudioContext stops when the machine has no audio output. __denyMicrophone and
  // __denyCamera refuse them; __userMediaCalls counts the calls, __userMediaConstraints keeps the last constraints,
  // __microphones and __cameras the streams.
  window.__userMediaCalls = 0;
  window.__userMediaConstraints = null;
  window.__denyMicrophone = false;
  window.__denyCamera = false;
  window.__microphones = [];
  window.__cameras = [];
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    window.__userMediaCalls++;
    window.__userMediaConstraints = constraints;
    if ((constraints.audio && window.__denyMicrophone) || (constraints.video && window.__denyCamera)) {
      throw new DOMException("denied", "NotAllowedError");
    }
    const stream = await nativeGetUserMedia(constraints);
    (constraints.video ? window.__cameras : window.__microphones).push(stream);
    return stream;
  };

  // Headless Chrome cannot accept the screen picker. __nextCapture sets the size, a fixed color and audio of the next
  // capture, its frame rate and the surface it reports; by default it is 640x360 at 20 fps, with changing colors and
// no audio.
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
    // A black and white checkerboard, of 16 px squares by default, to measure how sharp the received video is
    let fill = options.color;
    if (options.pattern === "checker") {
      const square = options.square ?? 16;
      const tile = document.createElement("canvas");
      tile.width = square * 2;
      tile.height = square * 2;
      const tileContext = tile.getContext("2d");
      tileContext.fillStyle = "white";
      tileContext.fillRect(0, 0, square * 2, square * 2);
      tileContext.fillStyle = "black";
      tileContext.fillRect(0, 0, square, square);
      tileContext.fillRect(square, square, square, square);
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
    if (options.surface) {
      const video = stream.getVideoTracks()[0];
      const getSettings = video.getSettings.bind(video);
      video.getSettings = () => ({ ...getSettings(), displaySurface: options.surface });
    }
    window.__captures.push(stream);
    return stream;
  };
})();
`;

// The average color and the size of what the page's <video> shows, or null if it shows nothing
const VIDEO_COLOR = `(() => {
  const video = document.querySelector('[data-testid="tile"] video');
  if (video == null || video.videoWidth === 0) return null;
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

const waitColor = async (page, desc, predicate, timeout = 10000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await page.eval(VIDEO_COLOR);
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`${page.label}: timeout waiting for ${desc}\nlast color: ${JSON.stringify(last)}`);
};

const PAGE_STATE = `(() => {
  const capture = window.__captures.at(-1);
  const tiles = $$t("tile");
  const screens = tiles.filter((tile) => tile.dataset.kind === "screen");
  const selfVideo = screens.find((tile) => tile.hasAttribute("data-self"))?.querySelector("video");
  const remoteVideos = screens.filter((tile) => !tile.hasAttribute("data-self")).map((tile) => tile.querySelector("video"));
  // The status of the whole page, or else that of the first tile that shows one
  const pageStatus = $t("page-status");
  const tileStatus = tiles.find((tile) => tile.dataset.status != null);
  const text = (element) => element?.textContent.trim().replace(/\\s+/g, " ") ?? null;
  const form = $t("present-form");
  const notices = [...document.querySelectorAll('[data-testid^="notice-"]')];
  const toolbar = $t("toolbar");
  return {
    status: pageStatus != null ? "status-" + pageStatus.dataset.status : tileStatus != null ? "status-" + tileStatus.dataset.status : null,
    statusText: pageStatus != null ? text(pageStatus) : text(tileStatus?.querySelector('[data-testid="tile-status"]')),
    tiles: tiles.map((tile) => ({
      name: tile.querySelector('[data-testid="tile-name"]').textContent,
      self: tile.hasAttribute("data-self"),
      status: tile.dataset.status == null ? null : "status-" + tile.dataset.status,
      playing: tile.querySelector("video").videoWidth > 0 && !tile.querySelector("video").paused,
      muted: tile.querySelector("video").muted,
      spotlighted: tile.hasAttribute("data-spotlighted"),
    })),
    notices: notices.map((notice) => notice.dataset.testid),
    noticeText: notices.map((notice) => text(notice)),
    dialogOpen: form != null,
    dialogMode: form?.dataset.mode ?? null,
    // The presenters to choose from in a full room, or null when the dialog does not ask
    replaceOptions: $t("present-replace") == null ? null : $$t("present-replace-option").map((input) => ({ name: input.closest(".mantine-Radio-root").textContent.trim(), checked: input.checked })),
    nameValue: $t("present-name")?.value ?? null,
    // The controls in the toolbar, by test ID
    toolbar: toolbar == null ? [] : [...toolbar.querySelectorAll("[data-testid]")].map((element) => element.dataset.testid).filter((id) => id !== "chat-unread"),
    viewers: $t("viewers")?.textContent.match(/\\d+/)?.[0] ?? "0",
    videoLocal: capture != null && selfVideo?.srcObject === capture,
    videoPlaying: remoteVideos.some((video) => video.srcObject != null && video.videoWidth > 0 && !video.paused),
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
  async submitDialog(name) {
    await this.type(tid("present-name"), name);
    // React enables the button once the name is valid
    await sleep(50);
    return this.click(tid("present-submit"));
  }
  // Sets the value of an input, a textarea or a select as typing would: React listens to the input and change events,
  // and to focusout for onBlur
  type(selector, value, { blur = false } = {}) {
    return this.eval(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set;
      setter.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (${blur}) element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    })()`);
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
  // Closes a notice with its close button, and waits until it has left
  async closeNotice(id) {
    await this.eval(
      `document.querySelector('[data-testid="${id}"]').closest(".mantine-Notification-root").querySelector(".mantine-Notification-closeButton").click()`,
      true,
    );
    await this.waitForEval(`${id} closed`, `document.querySelector('[data-testid="${id}"]') == null`);
  }
  // Opens the menu, a drawer whose content only exists while it is open
  async openMenu() {
    if (await this.eval(`$t("menu-link") != null`)) return;
    await this.waitForEval("the menu button", `$t("menu-open") != null`);
    await this.click(tid("menu-open"));
    await this.waitForEval("the menu", `$t("menu-link") != null`);
  }
  async closeMenu() {
    if (await this.eval(`$t("menu-link") == null`)) return;
    await this.eval(`document.querySelector(".mantine-Drawer-close").click()`, true);
    await this.waitForEval("the menu closed", `$t("menu-link") == null`);
  }
  async waitForEval(desc, expression, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(expression)) return;
      await sleep(100);
    }
    throw new Error(`${this.label}: timeout waiting for ${desc}`);
  }
}

const newPage = async (cdp, label, { acceptLanguage = "en-US", initExtra = "" } = {}) => {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  return newPageInContext(cdp, label, browserContextId, { acceptLanguage, initExtra });
};

const newPageInContext = async (cdp, label, browserContextId, { acceptLanguage = "en-US", initExtra = "" } = {}) => {
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
};

const results = [];
const step = async (name, fn) => {
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
};

const isPortInUse = (port) => {
  return new Promise((resolve) => {
    const probe = net.connect(port, "localhost");
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
};

const main = async () => {
  // Other servers on these ports would get the checks instead, with other timers
  const busy = [];
  for (const port of [4000, 8080, PROXY_PORT, WRANGLER_PORT, CDP_PORT]) {
    if (await isPortInUse(port)) busy.push(port);
  }
  if (busy.length > 0) {
    throw new Error(`Ports in use: ${busy.join(", ")}. Stop the servers that use them and try again.`);
  }

  // Build the website first: "go run" would start it as a child process that cleanup() could not kill
  const website = join(mkdtempSync(join(tmpdir(), "screensy-website-")), "screensy-website");
  execFileSync("go", ["build", "-o", website, "."], { cwd: join(REPO, "screensy-website"), stdio: "inherit" });

  const startRendezvous = (maxPresenters, env = {}) =>
    run("node", ["server.ts"], {
      cwd: join(REPO, "screensy-rendezvous"),
      env: {
        ...process.env,
        SCREENSY_LEFT_GRACE_MS: "12000",
        SCREENSY_LOST_GRACE_MS: "60000",
        SCREENSY_MAX_PRESENTERS: maxPresenters,
        // No STUN server: the pages connect on this machine, so the test does not reach the internet
        SCREENSY_STUN_URLS: "",
        ...env,
      },
    });
  // Most scenarios are about one presenter at a time; the last ones use the default of four
  let rendezvous = startRendezvous("1");
  const restartRendezvous = async (maxPresenters, env) => {
    rendezvous.kill();
    const end = Date.now() + 10000;
    while (await isPortInUse(4000)) {
      if (Date.now() > end) throw new Error("the rendezvous server did not stop");
      await sleep(100);
    }
    rendezvous = startRendezvous(maxPresenters, env);
    while (!(await isPortInUse(4000))) {
      if (Date.now() > end + 10000) throw new Error("the rendezvous server did not start");
      await sleep(100);
    }
  };
  run(website, [], { cwd: join(REPO, "screensy-website") });
  startProxy();
  run(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "screensy-e2e-"))}`,
    "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
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
    // The browser should not offer or save names: screensy remembers the name itself
    assert.equal(
      await a.eval(`$t("present-name").autocomplete === "off" && !$t("present-name").hasAttribute("name")`),
      true,
    );
    room = s.hash;
    await a.shot("1-start-dialog-en");
  });

  await step("creator starts presenting", async () => {
    await a.submitDialog("Alice");
    const s = await a.waitFor("presenting", (s) => s.videoLocal && s.toolbar.includes("stop"));
    assert.ok(!s.toolbar.includes("present"));
    assert.equal(s.status, null);
    assert.equal(s.viewers, "0");
    await a.shot("2-presenting-en");
  });

  await step("viewer (ja) joins and receives the stream", async () => {
    await b.goto(`${ORIGIN}/${room}`);
    const s = await b.waitFor("video", (s) => s.videoPlaying);
    assert.equal(s.lang, "ja");
    assert.equal(s.status, null);
    assert.deepEqual(s.toolbar, ["present", "call-join", "chat-toggle", "menu-open"]);
    await a.waitFor("viewer count 1", (s) => s.viewers === "1");
    await b.shot("3-viewing-ja");
    await a.shot("3b-presenting-1-viewer-en");
  });

  await step("viewer takes over after the confirmation dialog", async () => {
    await b.click(tid("present"));
    const s = await b.waitFor("takeover dialog", (s) => s.dialogOpen);
    assert.deepEqual(s.replaceOptions, [{ name: "Alice", checked: true }]);
    await b.shot("4-takeover-dialog-ja");
    await b.submitDialog("Bob");
    await b.waitFor("B presenting", (s) => s.videoLocal && s.toolbar.includes("stop"));
    const sa = await a.waitFor(
      "A notified and viewing B",
      (s) => s.notices.includes("notice-taken-over") && s.videoPlaying,
    );
    assert.match(sa.noticeText[0], /Bob/);
    assert.equal(sa.captureLive, false);
    await a.shot("5-taken-over-notice-en");
    assert.deepEqual(sa.toolbar, ["present", "call-join", "chat-toggle", "menu-open"]);
  });

  await step("browser 'Stop sharing' (track ended) stops presenting", async () => {
    await b.eval(`window.__captures.at(-1).getVideoTracks()[0].dispatchEvent(new Event("ended"))`);
    await b.waitFor(
      "B stopped",
      (s) => !s.videoLocal && s.toolbar.includes("present") && s.status === "status-waiting",
    );
    await b.shot("6-waiting-ja");
    await a.waitFor("A waiting", (s) => s.status === "status-waiting");
  });

  await step("stop button stops presenting", async () => {
    await a.click(tid("present"));
    const s = await a.waitFor("dialog with stored name", (s) => s.dialogOpen);
    assert.equal(s.nameValue, "Alice", "name remembered");
    assert.equal(s.replaceOptions, null);
    await a.submitDialog("Alice");
    await b.waitFor("B viewing A", (s) => s.videoPlaying);
    await a.click(tid("stop"));
    await a.waitFor("A stopped", (s) => !s.videoLocal && s.status === "status-waiting");
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
  });

  await step("denied capture shows a dismissible notice and changes nothing", async () => {
    await a.eval("window.__denyCapture = true");
    await a.click(tid("present"));
    await a.waitFor("dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    const s = await a.waitFor("notice", (s) => s.notices.includes("notice-access-denied"));
    assert.equal(s.videoLocal, false);
    await a.closeNotice("notice-access-denied");
    await a.waitFor("notice closed", (s) => s.notices.length === 0);
    await a.eval("window.__denyCapture = false");
  });

  await step("presenter reloads and resumes from the dialog", async () => {
    await a.click(tid("present"));
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
    await a.closeMenu();
    await a.reload();
    await a.waitFor("resume dialog", (s) => s.dialogOpen && s.dialogMode === "resume");
    await b.waitFor("B sees resuming", (s) => s.status === "status-presenter-resuming");
    await b.click(tid("present"));
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
    await b.click(tid("present-cancel"));
    await a.waitFor("A waiting", (s) => s.status === "status-waiting");
    const s = await b.state();
    assert.equal(s.status, "status-waiting");
    assert.deepEqual(s.toolbar, ["present", "call-join", "chat-toggle", "menu-open"]);
  });

  await step("duplicated presenter tab: the seat moves to the duplicate, the original stops", async () => {
    await a.eval(`document.querySelectorAll(".mantine-Notification-closeButton").forEach((b) => b.click())`);
    await a.click(tid("present"));
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
      await a.waitFor("A reconnected", (s) => s.toolbar.includes("present"), 15000);
      await a.click(tid("present"));
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
    await page.click(tid("switch"));
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
    assert.ok(sa.toolbar.includes("switch"));
  });

  await step("a cancelled switch keeps the current screen", async () => {
    await a.eval("window.__denyCapture = true");
    await a.click(tid("switch"));
    await sleep(500);
    await a.eval("window.__denyCapture = false");
    const sa = await a.state();
    assert.ok(sa.videoLocal && sa.captureLive);
    assert.equal(sa.notices.length, 0);
    assert.equal(await a.eval(`$t("switch").disabled`), false);
    await waitColor(b, "B still sees red", isRed);
  });

  await step("hiding the screen: black and silent for the viewers and in the presenter's preview", async () => {
    await a.click(tid("hide"));
    const sb = await b.waitFor("B sees hidden", (s) => s.status === "status-presenter-hidden");
    assert.equal(sb.statusText, "Aliceさんが画面を一時的に隠しています。");
    await waitColor(b, "B sees black", isBlack);
    const sa = await a.waitFor("A sees self hidden", (s) => s.status === "status-self-hidden");
    assert.ok(sa.toolbar.includes("show") && !sa.toolbar.includes("hide"));
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
    await a.click(tid("show"));
    await waitColor(b, "B sees blue", (c) => isBlue(c) && c.width === 640 && c.height === 480);
    await waitColor(c, "C sees blue", isBlue);
    await b.waitFor("B status cleared", (s) => s.status == null);
    await a.waitFor("A status cleared", (s) => s.status == null && s.toolbar.includes("hide"));
    const end = Date.now() + 10000;
    while (
      !(await b.eval(
        `document.querySelector('[data-testid="tile"] video').srcObject?.getAudioTracks()[0]?.muted === false`,
      ))
    ) {
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
    await a.click(tid("hide"));
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
    await a.click(tid("show"));
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
    await a.closeNotice("notice-switch-failed");
  });

  await step("a viewer who joins during a switch gets the new screen", async () => {
    await a.eval(`(() => {
      window.__gate = new Promise((resolve) => (window.__openGate = resolve));
      window.__replaceHook = () => window.__gate;
    })()`);
    const pcs = await a.eval("window.__pcs.length");
    await switchTo(a, { width: 1280, height: 720, color: "rgb(255, 255, 0)" });
    assert.equal(await a.eval(`$t("switch").disabled`), true);
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
    await a.waitFor("switch button enabled", (s) => s.toolbar.includes("switch"));
    assert.equal(await a.eval(`$t("switch").disabled`), false);
  });

  await step("'Stop sharing' on a switched screen stops presenting", async () => {
    await a.eval(`window.__captures.at(-1).getVideoTracks()[0].dispatchEvent(new Event("ended"))`);
    await a.waitFor("A stopped", (s) => !s.toolbar.includes("stop") && s.toolbar.includes("present"));
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
    for (const page of [c, d]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
  });

  // --- Menu and quality settings ---

  // The quality settings as the menu shows them. The menu opens for it and closes again.
  const menuValues = async (page) => {
    await page.openMenu();
    const values = await page.eval(`({
      frameRate: $t("quality-frame-rate").value,
      resolution: $t("quality-resolution").value,
      bitrate: $t("quality-bitrate").value,
      degradation: $t("quality-degradation").value,
    })`);
    await page.closeMenu();
    return values;
  };
  // Changes an input of the menu, like a person who then leaves it
  const setInput = async (page, id, value) => {
    await page.openMenu();
    await page.type(tid(id), value, { blur: true });
    await sleep(100);
    await page.closeMenu();
  };
  const videoParameters = `${openSenders("video")}.map((s) => {
    const p = s.getParameters();
    return { ...p.encodings[0], degradationPreference: p.degradationPreference, contentHint: s.track.contentHint };
  })`;
  const waitEval = async (page, desc, expression, predicate, timeout = 10000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await page.eval(expression);
      if (predicate(last)) return last;
      await sleep(200);
    }
    throw new Error(`${page.label}: timeout waiting for ${desc}\nlast: ${JSON.stringify(last)}`);
  };

  await step("the menu opens and shows the default quality settings", async () => {
    const sa = await a.state();
    assert.ok(sa.toolbar.includes("menu-open"));
    await a.openMenu();
    await a.shot("15-menu-en");
    await a.closeMenu();
    assert.deepEqual(await menuValues(a), {
      frameRate: "60",
      resolution: "",
      bitrate: "100",
      degradation: "maintain-resolution",
    });
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

    await a.click(tid("present"));
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

  await step("a value that is not one of the choices is not applied and the input goes back", async () => {
    await setInput(a, "quality-frame-rate", "0");
    await setInput(a, "quality-bitrate", "3");
    assert.deepEqual(await menuValues(a), {
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
    assert.deepEqual(await menuValues(a3), {
      frameRate: "30",
      resolution: "360",
      bitrate: "2",
      degradation: "maintain-framerate",
    });
    await a3.eval(
      `localStorage.setItem("screensy.quality", JSON.stringify({ frameRate: 45, maxHeight: 720, maxBitrateMbps: 3, degradation: "fast" }))`,
    );
    await a3.reload();
    assert.deepEqual(await menuValues(a3), {
      frameRate: "60",
      resolution: "720",
      bitrate: "100",
      degradation: "maintain-resolution",
    });
    // Stored values that are not an object at all: the page still starts, with the defaults
    for (const stored of ["{broken", "null", "[60]", "42"]) {
      await a3.eval(`localStorage.setItem("screensy.quality", ${JSON.stringify(stored)})`);
      await a3.reload();
      await a3.waitFor(`A3 joined with ${stored}`, (s) => s.toolbar.includes("menu-open"));
      assert.deepEqual(
        await menuValues(a3),
        { frameRate: "60", resolution: "", bitrate: "100", degradation: "maintain-resolution" },
        `stored ${stored}`,
      );
    }
    for (const page of [a3, c]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
    await a.click(tid("stop"));
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
  });

  // --- Menu: link, name, participants ---

  const isShown = (id) => `$t(${JSON.stringify(id)}) != null`;
  // The participants in the menu, which has to be open
  const PARTICIPANTS = `({
    count: $t("menu-participants").querySelector("h3").textContent.match(/\\d+/)[0],
    list: $$t("participant").map((row) => ({
      name: row.querySelector('[data-testid="participant-name"]').textContent,
      badges: [...row.querySelectorAll(".mantine-Badge-root")].map((badge) => badge.textContent),
    })),
  })`;
  let e;

  await step("everyone gets the menu; without screen sharing, it has no quality section", async () => {
    assert.ok((await b.state()).toolbar.includes("menu-open"));
    await b.openMenu();
    assert.equal(await b.eval(isShown("menu-quality")), true);
    await b.closeMenu();
    e = await newPage(cdp, "E", {
      initExtra: "delete navigator.mediaDevices.getDisplayMedia; delete MediaDevices.prototype.getDisplayMedia;",
    });
    await e.goto(`${ORIGIN}/${room}`);
    const se = await e.waitFor("E joined", (s) => s.status === "status-waiting");
    assert.deepEqual(se.toolbar, ["call-join", "chat-toggle", "menu-open"]);
    await e.openMenu();
    assert.equal(await e.eval(isShown("menu-quality")), false);
    await e.closeMenu();
  });

  await step("the link of the room can be copied", async () => {
    await b.openMenu();
    assert.equal(await b.eval(`$t("room-link").value === location.href`), true);
    await cdp.send("Browser.grantPermissions", {
      origin: ORIGIN,
      browserContextId: b.browserContextId,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await b.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await b.click(tid("copy-link"));
    await waitEval(b, "copied", isShown("copy-copied"), (shown) => shown === true);
    assert.equal(await b.eval("navigator.clipboard.readText().then((text) => text === location.href)"), true);
    await b.shot("16-menu-ja");

    // Without the clipboard, the link is selected for copying by hand
    await b.eval(`navigator.clipboard.writeText = () => Promise.reject(new Error("blocked"))`);
    await b.click(tid("copy-link"));
    await waitEval(b, "copy failed", isShown("copy-failed"), (shown) => shown === true);
    assert.equal(await b.eval(isShown("copy-copied")), false);
    assert.equal(
      await b.eval(`(() => {
        const input = $t("room-link");
        return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
      })()`),
      true,
    );
    await b.closeMenu();
  });

  await step("a viewer sets their name in the menu; everyone sees it, and the browser remembers it", async () => {
    await setInput(b, "menu-name-input", "  Bobby  ");
    await a.openMenu();
    await waitEval(a, "Bobby in A's list", PARTICIPANTS, (p) => p.list.some((entry) => entry.name === "Bobby"));
    await b.openMenu();
    await waitEval(b, "the trimmed name in B's input", `$t("menu-name-input").value`, (v) => v === "Bobby");
    assert.equal(await b.eval(`localStorage.getItem("screensy.name")`), "Bobby");

    await b.reload();
    await waitEval(a, "Bobby after B's reload", PARTICIPANTS, (p) => p.list.some((entry) => entry.name === "Bobby"));
    await b.openMenu();
    assert.equal(await b.eval(`$t("menu-name-input").value`), "Bobby");
    await b.closeMenu();
    await a.closeMenu();
    await b.click(tid("present"));
    const sb = await b.waitFor("B dialog", (s) => s.dialogOpen);
    assert.equal(sb.nameValue, "Bobby");
    await b.click(tid("present-cancel"));
  });

  await step("the participant list shows who presents, who you are, and who is reconnecting", async () => {
    await a.click(tid("present"));
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal);
    // E has no name: a guest numbered by its participant ID
    const guestId = await b.eval(`window.__roomState.participants.find((p) => p.name === "").id`);
    await a.openMenu();
    await b.openMenu();
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
    await a.click(tid("present-cancel"));
    await waitEval(b, "Alice viewing", PARTICIPANTS, (p) => p.list.every((entry) => !entry.badges.includes("配信中")));
    await cdp.send("Target.closeTarget", { targetId: e.targetId });
    await waitEval(b, "two left", PARTICIPANTS, (p) => p.count === "2");
    await b.closeMenu();
  });

  // --- Menu: connection statistics ---

  // The statistics in the menu, which has to be open
  const STATS = `({
    empty: $t("stats-empty") != null,
    entries: $$t("stats-entry").map((entry) => ({
      name: entry.querySelector('[data-testid="stats-name"]').textContent,
      fields: Object.fromEntries([...entry.querySelectorAll("td[data-field]")].map((td) => [td.dataset.field, td.textContent])),
    })),
  })`;
  const filled = (fields) => fields.bitrate !== "—" && fields.roundTripTime !== "—" && fields.resolution !== "—";

  await step("a viewer sees the statistics of the stream they receive", async () => {
    await a.click(tid("present"));
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal);
    await b.waitFor("B viewing", (s) => s.videoPlaying, 15000);
    await b.openMenu();
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
    await a.openMenu();
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
    await a.closeMenu();
    await b.closeMenu();
    await sleep(300);
    const before = [await a.eval("window.__getStatsCalls"), await b.eval("window.__getStatsCalls")];
    await sleep(2500);
    const after = [await a.eval("window.__getStatsCalls"), await b.eval("window.__getStatsCalls")];
    assert.deepEqual(after, before);
    await b.openMenu();
    await sleep(2500);
    assert.ok((await b.eval("window.__getStatsCalls")) >= before[1] + 2, "collects again when opened");
  });

  await step("without a stream, the menu says that there are no statistics", async () => {
    await a.click(tid("stop"));
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
    const stats = await waitEval(b, "no statistics", STATS, (s) => s.empty && s.entries.length === 0);
    assert.equal(stats.entries.length, 0);
    await b.closeMenu();
  });

  // --- Blur ---

  // The average difference between horizontal neighbors, drawn at 320x180: about 30 for the checkerboard, near 0 when
  // blurred
  const VIDEO_EDGES = `(() => {
    const video = document.querySelector('[data-testid="tile"] video');
    if (video == null || video.videoWidth === 0) return null;
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
    await a.click(tid("present"));
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal && s.toolbar.includes("blur"));
    const sharp = await waitEval(b, "B sees the sharp checkerboard", VIDEO_EDGES, isSharp, 15000);
    console.log(`     sharp: ${JSON.stringify(sharp)}`);
    const pcs = await b.eval("window.__pcs.length");
    const streamId = await b.eval("window.__roomState.presenters[0].streamId");

    const started = Date.now();
    await a.click(tid("blur"));
    const blurry = await waitEval(b, "B sees it blurred", VIDEO_EDGES, isBlurry, 10000);
    console.log(`     blurred after ${Date.now() - started} ms: ${JSON.stringify(blurry)}`);
    assert.equal(blurry.width, 160, "sent at a quarter of the size");
    await waitEval(a, "A's preview is blurred too", VIDEO_EDGES, isBlurry);
    const sa = await a.state();
    assert.ok(sa.toolbar.includes("unblur") && !sa.toolbar.includes("blur"));
    assert.equal(await b.eval("window.__pcs.length"), pcs, "no new connection");
    assert.equal(await b.eval("window.__roomState.presenters[0].streamId"), streamId);
    await a.shot("19-blurred-en");

    await sleep(3000);
    const fps = await b.eval(receivedFps);
    console.log(`     received while blurred: ${JSON.stringify(fps)} fps`);
    assert.ok(fps.length === 1 && fps[0] >= 15, "at least 3/4 of the 20 fps capture");
  });

  await step("unblurring brings the sharp screen back", async () => {
    await a.click(tid("unblur"));
    await waitEval(b, "B sees it sharp", VIDEO_EDGES, isSharp, 10000);
    await a.waitFor("blur button back", (s) => s.toolbar.includes("blur"));
  });

  await step("the strength slider changes the blur while blurred, but not the sent size", async () => {
    const sliderShown = `$t("blur-strength") != null`;
    // With the keys of the slider: Home goes to the minimum, and each ArrowRight adds a step of 1. The slider counts
    // from the value of its last render, so each key waits for the next one.
    const setStrength = (value) =>
      a.eval(`(async () => {
        const thumb = () => $t("blur-strength").querySelector('[role="slider"]');
        const press = async (key) => {
          thumb().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
        };
        await press("Home");
        for (let strength = 4; strength < ${value}; strength++) await press("ArrowRight");
      })()`);
    assert.equal(await a.eval(sliderShown), false, "no slider while sharp");
    // Squares of 64 px: a light blur still shows them, a strong one melts them
    await switchTo(a, { width: 640, height: 360, pattern: "checker", square: 64 });
    await waitEval(
      b,
      "B sees the large squares",
      VIDEO_EDGES,
      (v) => v != null && v.width === 640 && v.edges > 5,
      10000,
    );
    await a.click(tid("blur"));
    await waitEval(b, "B gets the blurred size", VIDEO_EDGES, (v) => v != null && v.width === 160, 10000);
    assert.equal(await a.eval(sliderShown), true);
    const shownStrength = `$t("blur-strength-value").textContent`;
    assert.equal(
      await a.eval(`$t("blur-strength").querySelector('[role="slider"]').getAttribute("aria-valuenow")`),
      "24",
      "the default strength",
    );
    assert.equal(await a.eval(shownStrength), "24", "the value is shown next to the slider");

    await setStrength(64);
    await sleep(1500);
    const strong = await b.eval(VIDEO_EDGES);
    assert.equal(await a.eval(shownStrength), "64");
    // The minimum
    await setStrength(4);
    const light = await waitEval(
      b,
      "a lighter blur",
      VIDEO_EDGES,
      (v) => v != null && v.edges > strong.edges + 1,
      10000,
    );
    console.log(`     strength 64: ${JSON.stringify(strong)}, strength 4: ${JSON.stringify(light)}`);
    assert.equal(strong.width, 160);
    assert.equal(light.width, 160, "the sent size stays the same");
    assert.equal(await a.eval(shownStrength), "4");
    assert.equal(await a.eval(`localStorage.getItem("screensy.blur")`), "4");

    await setStrength(24);
    await a.click(tid("unblur"));
    await a.waitFor("unblurred", (s) => s.toolbar.includes("blur"));
    assert.equal(await a.eval(sliderShown), false, "the slider goes with the blur");
    // Back to the small squares for the next scenarios
    await switchTo(a, CHECKER);
    await waitEval(b, "B sees the sharp checkerboard", VIDEO_EDGES, isSharp, 10000);
  });

  await step("a switch while blurred only ever sends the blurred video", async () => {
    await a.click(tid("blur"));
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
    await a.click(tid("hide"));
    await waitColor(b, "B sees black", isBlack);
    await a.eval("window.__replaced = []");
    await a.click(tid("unblur"));
    await a.waitFor("A unblurred", (s) => s.toolbar.includes("blur"));
    const video = await a.eval(`window.__replaced.filter((r) => r.kind === "video")`);
    assert.ok(video.length > 0 && video.every((r) => r.enabled === false), JSON.stringify(video));
    await sleep(1000);
    await waitColor(b, "B still sees black", isBlack);
    await a.click(tid("show"));
    await waitEval(b, "B sees the sharp screen", VIDEO_EDGES, isSharp, 10000);
  });

  await step("a blur that a connection rejects goes back and tells the presenter", async () => {
    await a.eval(`(() => {
      window.__replaceHook = async (sender, track) => {
        if (track != null && track.constructor.name === "MediaStreamTrackGenerator") throw new Error("injected failure");
      };
    })()`);
    await a.click(tid("blur"));
    const sa = await a.waitFor("A notified", (s) => s.notices.includes("notice-blur-failed"));
    await a.eval("window.__replaceHook = null");
    assert.ok(sa.toolbar.includes("blur"), "still not blurred");
    await sleep(1000);
    assert.ok(isSharp(await b.eval(VIDEO_EDGES)), "B still sees the sharp screen");
    await a.closeNotice("notice-blur-failed");
  });

  await step("a blurred screen stays blurred after an automatic resume", async () => {
    await a.click(tid("blur"));
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
    await a.click(tid("unblur"));
    await a.click(tid("stop"));
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
  });

  await step("without the breakout box, there is no blur button", async () => {
    const f = await newPage(cdp, "F", { initExtra: "delete window.MediaStreamTrackProcessor;" });
    await f.goto(`${ORIGIN}/`);
    await f.waitFor("F dialog", (s) => s.dialogOpen);
    await f.submitDialog("Frank");
    const sf = await f.waitFor("F presenting", (s) => s.videoLocal && s.toolbar.includes("hide"));
    assert.ok(!sf.toolbar.includes("blur") && !sf.toolbar.includes("unblur"));
    await cdp.send("Target.closeTarget", { targetId: f.targetId });
  });

  await step("a room that filled up while the dialog was open turns the new presenter away", async () => {
    const g = await newPage(cdp, "G");
    await g.goto(`${ORIGIN}/${room}`);
    await g.waitFor("G joined", (s) => s.status === "status-waiting");
    await g.click(tid("present"));
    const sg = await g.waitFor("G dialog", (s) => s.dialogOpen);
    assert.equal(sg.replaceOptions, null, "nobody presents yet");

    await a.click(tid("present"));
    await a.waitFor("A dialog", (s) => s.dialogOpen);
    await a.submitDialog("Alice");
    await a.waitFor("A presenting", (s) => s.videoLocal);

    await g.submitDialog("Gina");
    const sg2 = await g.waitFor("G notified", (s) => s.notices.includes("notice-full"));
    assert.equal(sg2.noticeText[0], "The room is full of presenters now. Try again.");
    assert.ok(!sg2.toolbar.includes("stop") && !sg2.captureLive);
    assert.ok((await a.state()).videoLocal, "A still presents");
    await b.waitFor("B viewing A", (s) => s.videoPlaying, 15000);
    await cdp.send("Target.closeTarget", { targetId: g.targetId });
    await a.click(tid("stop"));
    await b.waitFor("B waiting", (s) => s.status === "status-waiting");
  });

  // --- Several presenters: the rendezvous server restarts with its default limit of four ---

  const inTile = (name, expression) =>
    `(() => {
      const tile = $$t("tile").find((t) => t.querySelector('[data-testid="tile-name"]').textContent === ${JSON.stringify(name)});
      if (tile == null) return null;
      const video = tile.querySelector("video");
      return ${expression};
    })()`;
  const tileColor = (page, name) =>
    page.eval(
      inTile(
        name,
        `(() => {
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
          return { r: r / n, g: g / n, b: b / n };
        })()`,
      ),
    );
  const waitTileColor = async (page, name, predicate, timeout = 15000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await tileColor(page, name);
      if (predicate(last)) return last;
      await sleep(200);
    }
    throw new Error(`${page.label}: timeout waiting for ${name}'s color\nlast: ${JSON.stringify(last)}`);
  };
  const clickTile = (page, name, selector) =>
    page.eval(inTile(name, `tile.querySelector(${JSON.stringify(tid(selector ?? "tile-spotlight"))}).click()`), true);
  const presentAs = async (page, name, capture) => {
    await page.eval(`window.__nextCapture = ${JSON.stringify(capture)}`);
    await page.click(tid("present"));
    const s = await page.waitFor(`${page.label} dialog`, (s) => s.dialogOpen);
    await page.submitDialog(name);
    await page.waitFor(`${page.label} presenting`, (s) => s.videoLocal);
    return s;
  };
  let p1;
  let p2;
  let p3;
  let p4;
  let p5;
  let viewer;
  let multiRoom;

  await step("the server restarts with up to four presenters and two cameras", async () => {
    for (const page of [a, b]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
    // Two cameras, so that the call can check the limit
    await restartRendezvous("4", { SCREENSY_MAX_CAMERAS: "2" });
  });

  await step("two presenters are shown side by side, to viewers and to each other", async () => {
    p1 = await newPage(cdp, "P1");
    await p1.goto(`${ORIGIN}/`);
    const s1 = await p1.waitFor("P1 start dialog", (s) => s.dialogOpen);
    multiRoom = s1.hash;
    await p1.eval(`window.__nextCapture = ${JSON.stringify({ color: "rgb(255, 0, 0)" })}`);
    await p1.submitDialog("Pia");
    await p1.waitFor("P1 presenting", (s) => s.videoLocal);
    assert.equal(
      await p1.eval(
        `window.__displayOptions.audio.restrictOwnAudio === true && window.__displayOptions.selfBrowserSurface === "exclude"`,
      ),
      true,
      "asks to keep this page's sound out and this tab out",
    );

    p2 = await newPage(cdp, "P2");
    await p2.goto(`${ORIGIN}/${multiRoom}`);
    await p2.waitFor("P2 joined", (s) => s.tiles.length === 1);
    const s2 = await presentAs(p2, "Pablo", { color: "rgb(0, 0, 255)" });
    assert.equal(s2.replaceOptions, null, "joins without choosing anyone");

    viewer = await newPage(cdp, "V", { acceptLanguage: "ja" });
    await viewer.goto(`${ORIGIN}/${multiRoom}`);
    const sv = await viewer.waitFor(
      "V sees two playing tiles",
      (s) => s.tiles.length === 2 && s.tiles.every((t) => t.playing),
      15000,
    );
    assert.deepEqual(
      sv.tiles.map((t) => t.name),
      ["Pia", "Pablo"],
    );
    await waitTileColor(viewer, "Pia", isRed);
    await waitTileColor(viewer, "Pablo", isBlue);

    const sp1 = await p1.waitFor("P1 sees Pablo", (s) => s.tiles.length === 2 && s.tiles[1].playing, 15000);
    assert.deepEqual(
      sp1.tiles.map((t) => [t.name, t.self, t.muted]),
      [
        ["You", true, true],
        ["Pablo", false, false],
      ],
    );
    await viewer.shot("20-two-presenters-ja");
  });

  await step("clicking a tile enlarges it, and it goes back with another click or when it ends", async () => {
    await clickTile(viewer, "Pia");
    let s = await viewer.waitFor("Pia enlarged", (s) => s.tiles.find((t) => t.name === "Pia")?.spotlighted);
    assert.equal(await viewer.eval(`$t("stage").hasAttribute("data-spotlight")`), true);
    await viewer.shot("21-spotlight-ja");
    await clickTile(viewer, "Pia");
    s = await viewer.waitFor("back to even", (s) => s.tiles.every((t) => !t.spotlighted));
    assert.equal(await viewer.eval(`$t("stage").hasAttribute("data-spotlight")`), false);

    await clickTile(viewer, "Pablo");
    await viewer.waitFor("Pablo enlarged", (s) => s.tiles.find((t) => t.name === "Pablo")?.spotlighted);
    await p2.click(tid("stop"));
    s = await viewer.waitFor("Pablo gone", (s) => s.tiles.length === 1);
    assert.equal(s.tiles[0].spotlighted, false);
    assert.equal(await viewer.eval(`$t("stage").hasAttribute("data-spotlight")`), false);
    await presentAs(p2, "Pablo", { color: "rgb(0, 0, 255)" });
    await viewer.waitFor(
      "V sees two playing tiles",
      (s) => s.tiles.length === 2 && s.tiles.every((t) => t.playing),
      15000,
    );
  });

  await step("each tile has its own mute button, and the own tile stays muted", async () => {
    await clickTile(viewer, "Pia", "tile-mute");
    let s = await viewer.waitFor("Pia muted", (s) => s.tiles.find((t) => t.name === "Pia")?.muted === true);
    assert.equal(s.tiles.find((t) => t.name === "Pablo").muted, false, "Pablo still plays sound");
    assert.equal(
      await viewer.eval(inTile("Pia", `tile.querySelector('[data-testid="tile-mute"]').getAttribute("aria-label")`)),
      "消音を解除",
    );
    await clickTile(viewer, "Pia", "tile-mute");
    s = await viewer.waitFor("Pia unmuted", (s) => s.tiles.find((t) => t.name === "Pia")?.muted === false);
    assert.equal(
      await p1.eval(`document.querySelector('[data-testid="tile"][data-self] [data-testid="tile-mute"]') == null`),
      true,
    );
  });

  await step("up to four join without a question, and the fifth chooses whom to take over", async () => {
    p3 = await newPage(cdp, "P3");
    await p3.goto(`${ORIGIN}/${multiRoom}`);
    await p3.waitFor("P3 joined", (s) => s.tiles.length === 2);
    assert.equal((await presentAs(p3, "Paul", { color: "rgb(0, 160, 0)" })).replaceOptions, null);
    p4 = await newPage(cdp, "P4");
    await p4.goto(`${ORIGIN}/${multiRoom}`);
    await p4.waitFor("P4 joined", (s) => s.tiles.length === 3);
    assert.equal((await presentAs(p4, "Pat", { color: "rgb(255, 255, 0)" })).replaceOptions, null);
    const sv = await viewer.waitFor(
      "V sees four",
      (s) => s.tiles.length === 4 && s.tiles.every((t) => t.playing),
      20000,
    );
    assert.deepEqual(
      sv.tiles.map((t) => t.name),
      ["Pia", "Pablo", "Paul", "Pat"],
    );
    await viewer.shot("22-four-presenters-ja");

    p5 = await newPage(cdp, "P5");
    await p5.goto(`${ORIGIN}/${multiRoom}`);
    await p5.waitFor("P5 joined", (s) => s.tiles.length === 4);
    await p5.click(tid("present"));
    const s5 = await p5.waitFor("P5 dialog", (s) => s.dialogOpen);
    assert.deepEqual(s5.replaceOptions, [
      { name: "Pia", checked: false },
      { name: "Pablo", checked: false },
      { name: "Paul", checked: false },
      { name: "Pat", checked: false },
    ]);
    assert.match(await p5.eval(`$t("present-replace").textContent`), /Up to 4 people/);
    await p5.shot("23-choose-replacement-en");
    await p5.eval(
      `$$t("present-replace-option").find((input) => input.closest(".mantine-Radio-root").textContent.trim() === "Pablo").click()`,
    );
    await p5.eval(`window.__nextCapture = ${JSON.stringify({ color: "rgb(255, 0, 255)" })}`);
    await p5.submitDialog("Penny");
    await p5.waitFor("P5 presenting", (s) => s.videoLocal);
    const s2 = await p2.waitFor("Pablo notified", (s) => s.notices.includes("notice-taken-over"));
    assert.equal(s2.noticeText[0], "Penny took over presenting.");
    const sv2 = await viewer.waitFor(
      "V sees Penny instead of Pablo",
      (s) => JSON.stringify(s.tiles.map((t) => t.name)) === JSON.stringify(["Pia", "Paul", "Pat", "Penny"]),
    );
    assert.equal(sv2.tiles.length, 4);
  });

  await step("statuses belong to their tile", async () => {
    await viewer.waitFor(
      "all four playing",
      (s) => s.tiles.length === 4 && s.tiles.every((t) => t.playing && t.status == null),
      15000,
    );
    await p3.click(tid("hide"));
    const sv = await viewer.waitFor(
      "Paul hidden",
      (s) => s.tiles.find((t) => t.name === "Paul")?.status === "status-presenter-hidden",
    );
    assert.deepEqual(
      sv.tiles.filter((t) => t.status != null).map((t) => t.name),
      ["Paul"],
    );
    await p3.click(tid("show"));
    await viewer.waitFor("Paul shown", (s) => s.tiles.every((t) => t.status == null));
  });

  await step("the statistics list every received presentation, and what a presenter sends", async () => {
    await viewer.openMenu();
    const stats = await waitEval(
      viewer,
      "four received",
      `(() => $$t("stats-entry").map((e) => [e.querySelector('[data-testid="stats-name"]').textContent, e.querySelector('[data-testid="stats-direction"]').textContent]))()`,
      (list) => list.length === 4,
    );
    assert.deepEqual(
      stats.map((entry) => entry[1]),
      ["受信", "受信", "受信", "受信"],
    );
    await viewer.closeMenu();
    await p1.openMenu();
    const own = await waitEval(
      p1,
      "sent and received",
      `(() => $$t("stats-entry").map((e) => e.querySelector('[data-testid="stats-direction"]').textContent))()`,
      (list) => list.includes("sending") && list.includes("receiving"),
    );
    console.log(`     P1 statistics: ${JSON.stringify(own)}`);
    await p1.closeMenu();
  });

  await step("sharing sound that may contain this page's sound mutes the other presenters on this page", async () => {
    await switchTo(p1, { color: "rgb(255, 0, 0)", audio: true, surface: "monitor" });
    const s = await p1.waitFor(
      "others muted and notified",
      (s) => s.notices.includes("notice-echo-muted") && s.tiles.filter((t) => !t.self).every((t) => t.muted),
    );
    assert.match(s.noticeText.join(" "), /The other presenters are muted/);
    // The person may still unmute one on purpose
    await clickTile(p1, "Paul", "tile-mute");
    await p1.waitFor("Paul unmuted on purpose", (s) => s.tiles.find((t) => t.name === "Paul")?.muted === false);
    await clickTile(p1, "Paul", "tile-mute");

    await p1.closeNotice("notice-echo-muted");
    await switchTo(p1, { color: "rgb(255, 0, 0)", audio: true, surface: "browser" });
    const s2 = await p1.waitFor(
      "a tab capture does not mute",
      (s) => s.tiles.find((t) => t.name === "Pat")?.muted === false,
    );
    assert.ok(!s2.notices.includes("notice-echo-muted"));
    for (const page of [p1, p2, p3, p4, p5, viewer]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
  });

  // --- Chat: peer to peer on the data channels of the mesh ---

  // The chat panel is always on the page, also while it is closed
  const CHAT = `(() => ({
    open: $t("chat-toggle")?.getAttribute("aria-pressed") === "true",
    unread: Number($t("chat-unread")?.dataset.unread ?? 0),
    reach: $t("chat-reach").textContent,
    enabled: !$t("chat-input").disabled,
    input: $t("chat-input").value,
    log: $$t("chat-message").map((message) => ({
      name: message.querySelector('[data-testid="chat-name"]').textContent,
      text: message.querySelector('[data-testid="chat-text"]')?.textContent ?? "",
      self: message.hasAttribute("data-self"),
    })),
  }))()`;
  const waitChat = async (page, desc, pred, timeout = 10000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await page.eval(CHAT);
      if (pred(last)) return last;
      await sleep(100);
    }
    throw new Error(`${page.label}: timeout waiting for ${desc}\nlast chat: ${JSON.stringify(last, null, 1)}`);
  };
  // Types the text and presses Enter, with the given modifiers of the key event. React gets the text before the key.
  const pressEnter = async (page, text, init = {}) => {
    await page.type(tid("chat-input"), text);
    await page.eval(
      `$t("chat-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...${JSON.stringify(init)} }))`,
    );
  };
  const texts = (chat) => chat.log.map((message) => `${message.name}: ${message.text}`);
  const withName = (name) => `try { localStorage.setItem("screensy.name", ${JSON.stringify(name)}); } catch {}`;
  const chatRoom = `${ORIGIN}/#ChatRoom${Date.now()}`;
  let c1;
  let c2;
  let c3;

  await step("chat: two pages exchange messages in the same order, with an unread count", async () => {
    c1 = await newPage(cdp, "C1", { initExtra: withName("Ann") });
    c2 = await newPage(cdp, "C2", { initExtra: withName("Ben") });
    await c1.goto(chatRoom);
    await c2.goto(chatRoom);
    await waitChat(c1, "C1 reaches C2", (c) => c.enabled && c.reach === "Reaches 1 of 1 people");
    await waitChat(c2, "C2 reaches C1", (c) => c.enabled && c.reach === "Reaches 1 of 1 people");
    await c1.click(tid("chat-toggle"));
    await pressEnter(c1, "hello from Ann");
    const sent = await waitChat(c1, "C1 shows its message", (c) => c.log.length === 1);
    assert.equal(sent.input, "", "the input is cleared");
    assert.deepEqual(sent.log, [{ name: "Ann", text: "hello from Ann", self: true }]);
    const got = await waitChat(c2, "C2 gets it", (c) => c.log.length === 1);
    assert.deepEqual(got.log, [{ name: "Ann", text: "hello from Ann", self: false }]);
    assert.equal(got.unread, 1);
    assert.equal(got.open, false);
    await c2.click(tid("chat-toggle"));
    const opened = await waitChat(c2, "C2 opened the chat", (c) => c.open);
    assert.equal(opened.unread, 0);
    await pressEnter(c2, "hi Ann\nsecond line");
    const both = await waitChat(c1, "C1 gets the answer", (c) => c.log.length === 2);
    assert.deepEqual(texts(both), ["Ann: hello from Ann", "Ben: hi Ann\nsecond line"]);
    assert.equal(both.unread, 0, "nothing is unread while the chat is open");
    assert.deepEqual(texts(await c2.eval(CHAT)), texts(both));
  });

  await step("chat: a late joiner gets the history from the peers", async () => {
    c3 = await newPage(cdp, "C3", { initExtra: withName("Cy") });
    await c3.goto(chatRoom);
    const history = await waitChat(c3, "C3 gets the history", (c) => c.log.length === 2);
    assert.deepEqual(texts(history), ["Ann: hello from Ann", "Ben: hi Ann\nsecond line"]);
    assert.equal(history.unread, 0, "the history does not count as unread");
    await waitChat(c3, "C3 reaches both", (c) => c.reach === "Reaches 2 of 2 people");
  });

  await step("chat: a lost message is asked for again when the next one shows the gap", async () => {
    // One send per peer
    await c1.eval("window.__chatDropLive = 2");
    await pressEnter(c1, "lost on the way");
    await sleep(800);
    assert.equal((await c2.eval(CHAT)).log.length, 2, "C2 did not get it");
    await pressEnter(c1, "after the lost one");
    // Much sooner than the periodic summary
    for (const page of [c2, c3]) {
      const chat = await waitChat(page, `${page.label} recovers it`, (c) => c.log.length === 4, 3000);
      assert.deepEqual(texts(chat).slice(2), ["Ann: lost on the way", "Ann: after the lost one"]);
    }
  });

  await step("chat: Enter while an input method composes, and Shift+Enter, do not send", async () => {
    await pressEnter(c3, "へんかんちゅう", { isComposing: true });
    await pressEnter(c3, "へんかんちゅう", { shiftKey: true });
    await sleep(500);
    const chat = await c3.eval(CHAT);
    assert.equal(chat.input, "へんかんちゅう");
    assert.equal(chat.log.length, 4);
    await pressEnter(c3, "変換しました");
    await waitChat(c1, "C1 gets the message of C3", (c) => c.log.length === 5);
  });

  await step("chat: a reload keeps the history without duplicates, and the page sends again", async () => {
    const before = texts(await c1.eval(CHAT));
    await c2.reload();
    const restored = await waitChat(c2, "C2 restored", (c) => c.enabled && c.log.length === before.length);
    assert.deepEqual(texts(restored), before);
    assert.ok(restored.log[1].self, "the message from before the reload is still the own one");
    await waitChat(c2, "C2 reaches both again", (c) => c.reach === "Reaches 2 of 2 people");
    // The peers send their summaries when the channels open: nothing is added twice
    await sleep(1000);
    assert.deepEqual(texts(await c2.eval(CHAT)), before);
    await pressEnter(c2, "back after the reload");
    for (const page of [c1, c3]) {
      await waitChat(page, `${page.label} gets the message after the reload`, (c) => c.log.length === 6);
    }
  });

  await step("chat: every page shows the same order", async () => {
    const [l1, l2, l3] = await Promise.all([c1, c2, c3].map((page) => page.eval(CHAT)));
    assert.equal(l1.log.length, 6);
    assert.deepEqual(texts(l2), texts(l1));
    assert.deepEqual(texts(l3), texts(l1));
    await c1.shot("chat");
  });

  await step("chat: a room that was created again does not get the old history", async () => {
    for (const page of [c2, c3]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
    // Leave and come back in the same tab, so that sessionStorage stays: the room is deleted meanwhile
    await c1.goto("about:blank");
    await sleep(500);
    await c1.goto(chatRoom);
    const chat = await waitChat(
      c1,
      "C1 back in an empty room",
      (c) => c.enabled && c.reach === "Nobody else is here yet",
    );
    assert.deepEqual(chat.log, []);
    await cdp.send("Target.closeTarget", { targetId: c1.targetId });
  });

  // --- Files: shared in the chat, fetched from the sender on the files channel of the mesh ---

  const FILES = `(() => $$t("chat-file").map((row) => ({
    id: row.dataset.fileId,
    name: row.querySelector('[data-testid="chat-file-name"]').textContent + " (" + row.querySelector('[data-testid="chat-file-size"]').textContent + ")",
    status: row.dataset.status,
    url: row.querySelector("a")?.href ?? null,
    download: row.querySelector("a")?.download ?? null,
    preview: (() => {
      const image = row.querySelector('[data-testid="chat-file-preview"] img');
      return image == null ? null : image.complete && image.naturalWidth > 0 ? "shown" : "loading";
    })(),
  })))()`;
  const waitFiles = async (page, desc, pred, timeout = 20000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await page.eval(FILES);
      if (pred(last)) return last;
      await sleep(100);
    }
    throw new Error(`${page.label}: timeout waiting for ${desc}\nlast files: ${JSON.stringify(last, null, 1)}`);
  };
  // The content of a test file of the given size, and a checksum of it, the same in the page and here
  const fileByte = (i) => (i * 7 + (i >> 11)) & 255;
  const checksum = (size) => {
    let sum = 0;
    for (let i = 0; i < size; i++) sum = (sum * 31 + fileByte(i)) >>> 0;
    return sum;
  };
  const attach = (page, name, size, type, input = "chat-file-input") =>
    page.eval(
      `(() => {
        const bytes = new Uint8Array(${size});
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 11)) & 255;
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
        const input = $t(${JSON.stringify(input)});
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    );
  const fetchedFile = (page, url) =>
    page.eval(
      `(async () => {
        const response = await fetch(${JSON.stringify(url)});
        const bytes = new Uint8Array(await response.arrayBuffer());
        let sum = 0;
        for (let i = 0; i < bytes.length; i++) sum = (sum * 31 + bytes[i]) >>> 0;
        return { size: bytes.length, sum, type: response.headers.get("content-type") };
      })()`,
    );
  const clickFile = (page, status) =>
    page.eval(
      `document.querySelector('[data-testid="chat-file"][data-status="${status}"] [data-testid="chat-file-download"]').click()`,
      true,
    );
  const BIG = 20_000_000;
  const filesRoom = `${ORIGIN}/#FilesRoom${Date.now()}`;
  let f1;
  let f2;
  let f3;
  let f4;
  // The files without their IDs, to compare
  const shown = (files) => files.map(({ id: _id, ...rest }) => rest);

  await step("files: a shared file shows in the others' chat, and downloads whole from the sender", async () => {
    f1 = await newPage(cdp, "F1", { initExtra: withName("Fay") });
    f2 = await newPage(cdp, "F2", { initExtra: withName("Gus") });
    await f1.goto(filesRoom);
    await f2.goto(filesRoom);
    await waitChat(f1, "F1 reaches F2", (c) => c.enabled && c.reach === "Reaches 1 of 1 people");
    await waitChat(f2, "F2 reaches F1", (c) => c.enabled && c.reach === "Reaches 1 of 1 people");
    // Larger than the 16 MB that the receiver folds into a Blob at once
    await attach(f1, "data.bin", BIG, "application/octet-stream");
    const own = await waitFiles(f1, "F1 shows its file", (files) => files.length === 1);
    assert.deepEqual(shown(own), [
      { name: "data.bin (20.0 MB)", status: "own", url: null, download: null, preview: null },
    ]);
    await waitFiles(f2, "F2 can download it", (files) => files[0]?.status === "idle");

    await clickFile(f2, "idle");
    // The chat goes on during the transfer, on its own channel
    await pressEnter(f1, "during the transfer");
    await waitChat(f2, "F2 gets the chat message", (c) => texts(c).includes("Fay: during the transfer"), 5000);
    const done = await waitFiles(f2, "F2 downloaded it", (files) => files[0]?.status === "done", 60000);
    assert.equal(done[0].download, "data.bin");
    assert.deepEqual(await fetchedFile(f2, done[0].url), {
      size: BIG,
      sum: checksum(BIG),
      type: "application/octet-stream",
    });
  });

  await step("files: a late joiner sees the file and gets it from one of those who have it", async () => {
    f3 = await newPage(cdp, "F3", { initExtra: withName("Hal") });
    await f3.goto(filesRoom);
    await waitFiles(f3, "F3 can download it", (files) => files[0]?.status === "idle");
    await clickFile(f3, "idle");
    const done = await waitFiles(f3, "F3 downloaded it", (files) => files[0]?.status === "done", 60000);
    assert.equal((await fetchedFile(f3, done[0].url)).sum, checksum(BIG));
  });

  await step("files: a received file is saved as data, under a cleaned name", async () => {
    // An HTML file that would run in this page's origin if opened from a Blob of its own type, under a name that
    // looks like a PDF
    await attach(f1, "evil\u202Efdp.html", 100, "text/html");
    const files = await waitFiles(f2, "F2 sees the HTML file", (files) => files[1]?.status === "idle");
    assert.equal(files[1].name, "evilfdp.html (100 B)", "without the right-to-left override");
    await clickFile(f2, "idle");
    const done = await waitFiles(f2, "F2 downloaded it", (files) => files[1]?.status === "done");
    assert.equal(done[1].download, "evilfdp.html");
    assert.deepEqual(await fetchedFile(f2, done[1].url), {
      size: 100,
      sum: checksum(100),
      type: "application/octet-stream",
    });
  });

  await step("files: a reload ends the sender's sharing, until the sender chooses the file again", async () => {
    await attach(f1, "report.txt", 2000, "text/plain");
    const before = await waitFiles(f2, "F2 sees the report", (files) => files[2]?.status === "idle");
    const reportId = before[2].id;
    await f1.reload();
    await waitChat(f1, "F1 back", (c) => c.enabled && c.reach === "Reaches 2 of 2 people", 15000);
    const ended = await waitFiles(f1, "F1's report ended", (files) => files[2]?.status === "ended");
    assert.equal(ended[0].status, "ended", "the big file too");
    // The sender is here, but nobody has the report; the big file is still with F2 and F3
    const f2Files = await waitFiles(f2, "F2 sees the report stopped", (files) => files[2]?.status === "stopped");
    assert.equal(f2Files[0].status, "done");
    const f3Files = await waitFiles(f3, "F3 sees the report stopped", (files) => files[2]?.status === "stopped");
    assert.equal(f3Files[1].status, "idle", "the HTML file is still with F2");

    await f1.eval(
      `document.querySelector('[data-testid="chat-file"][data-file-id="${reportId}"] [data-testid="chat-file-resume"]').click()`,
      true,
    );
    await attach(f1, "report.txt", 1999, "text/plain", "chat-resume-input");
    await f1.waitFor("F1 told that it is another file", (s) => s.notices.includes("notice-file-mismatch"));
    await attach(f1, "report.txt", 2000, "text/plain", "chat-resume-input");
    await waitFiles(f1, "F1 shares the report again", (files) => files[2]?.status === "own");
    await waitFiles(f2, "F2 can download the report again", (files) => files[2]?.status === "idle");
    await f2.eval(
      `document.querySelector('[data-testid="chat-file"][data-file-id="${reportId}"] [data-testid="chat-file-download"]').click()`,
      true,
    );
    const done = await waitFiles(f2, "F2 downloaded the report", (files) => files[2]?.status === "done");
    assert.equal((await fetchedFile(f2, done[2].url)).sum, checksum(2000));
  });

  await step(
    "files: when the sender leaves, a file stays with those who have it, and the others show as gone",
    async () => {
      await attach(f1, "notes.txt", 1000, "text/plain");
      await waitFiles(f2, "F2 sees the notes", (files) => files[3]?.status === "idle");
      await cdp.send("Target.closeTarget", { targetId: f1.targetId });
      const gone = await waitFiles(f2, "F2 cannot fetch the notes", (files) => files[3]?.status === "unreachable");
      assert.equal(gone[0].status, "done", "the downloaded file stays");
      // A newcomer gets the big file from F2 or F3
      f4 = await newPage(cdp, "F4", { initExtra: withName("Ida") });
      await f4.goto(filesRoom);
      await waitFiles(f4, "F4 can download the big file", (files) => files[0]?.status === "idle");
      await clickFile(f4, "idle");
      const done = await waitFiles(f4, "F4 downloaded it", (files) => files[0]?.status === "done", 60000);
      assert.equal((await fetchedFile(f4, done[0].url)).sum, checksum(BIG));
      for (const page of [f2, f3, f4]) {
        await cdp.send("Target.closeTarget", { targetId: page.targetId });
      }
    },
  );

  // --- Image previews: small raster images arrive without a click and show in the chat ---

  // Attaches a file of the given content: "png" for a real PNG image drawn on a canvas, "png-header:<size>" for that
  // many bytes after a PNG signature, or a text
  const attachContent = (page, name, type, content) =>
    page.eval(
      `(async () => {
        const content = ${JSON.stringify(content)};
        let blob;
        if (content === "png") {
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 48;
          const context = canvas.getContext("2d");
          context.fillStyle = "rgb(255, 0, 255)";
          context.fillRect(0, 0, 64, 48);
          blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        } else if (content.startsWith("png-header:")) {
          const bytes = new Uint8Array(Number(content.slice("png-header:".length)));
          bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          blob = new Blob([bytes]);
        } else {
          blob = new Blob([content]);
        }
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
        const input = $t("chat-file-input");
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    );
  // The type that the page gets for the URL of an image
  const urlType = (page, url) =>
    page.eval(`fetch(${JSON.stringify(url)}).then((response) => response.headers.get("content-type"))`);
  const previewUrl = (page, index) =>
    page.eval(`$$t("chat-file")[${index}].querySelector('[data-testid="chat-file-preview"] img').src`);
  const imagesRoom = `${ORIGIN}/#ImagesRoom${Date.now()}`;
  let i1;
  let i2;

  await step("images: the sender sees the preview at once, and the others get it without a click", async () => {
    i1 = await newPage(cdp, "I1", { initExtra: withName("Ivy") });
    i2 = await newPage(cdp, "I2", { initExtra: withName("Jon") });
    await i1.goto(imagesRoom);
    await i2.goto(imagesRoom);
    await waitChat(i1, "I1 reaches I2", (c) => c.enabled && c.reach === "Reaches 1 of 1 people");
    await waitChat(i2, "I2 reaches I1", (c) => c.enabled && c.reach === "Reaches 1 of 1 people");

    await attachContent(i1, "photo.png", "image/png", "png");
    await waitFiles(i1, "I1 previews its image", (files) => files[0]?.status === "own" && files[0].preview === "shown");
    const received = await waitFiles(
      i2,
      "I2 fetched and previews the image",
      (files) => files[0]?.status === "done" && files[0].preview === "shown",
    );
    // The preview has the type of its bytes; the saved file stays data
    assert.equal(await urlType(i2, await previewUrl(i2, 0)), "image/png");
    assert.equal((await fetchedFile(i2, received[0].url)).type, "application/octet-stream");

    await i2.eval(`$$t("chat-file-preview")[0].click()`, true);
    await waitEval(
      i2,
      "the image opens larger",
      `(() => {
      const image = $t("image-viewer");
      return image != null && image.naturalWidth === 64;
    })()`,
      (open) => open === true,
    );
    await i2.shot("image-preview");
    await i2.eval(`document.querySelector(".mantine-Modal-close").click()`, true);
    await waitEval(i2, "the image closes", `$t("image-viewer") == null`, (closed) => closed === true);

    // A reload forgets the received image; it arrives again from the history, without a click
    await i2.reload();
    await waitChat(i2, "I2 back", (c) => c.enabled && c.reach === "Reaches 1 of 1 people", 15000);
    await waitFiles(
      i2,
      "I2 fetched the image again",
      (files) => files[0]?.status === "done" && files[0].preview === "shown",
    );
  });

  await step("images: only raster images preview, and SVG or large images wait for a click", async () => {
    // HTML that names itself a PNG: fetched as a hint, but its bytes are no image
    await attachContent(i1, "fake.png", "image/png", "<script>alert(1)</script>");
    const fake = await waitFiles(i2, "I2 fetched the fake image", (files) => files[1]?.status === "done");
    await sleep(500);
    assert.equal((await i2.eval(FILES))[1].preview, null, "no preview of HTML");
    assert.equal((await fetchedFile(i2, fake[1].url)).type, "application/octet-stream");

    // SVG could run scripts in this page's origin, so it never previews, also for its sender
    await attachContent(i1, "vector.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>');
    // Larger than the 10 MiB that the receiver fetches without a click
    await attachContent(i1, "big.png", "image/png", `png-header:${11 * 1024 * 1024}`);
    await waitFiles(i2, "I2 sees the SVG and the large image", (files) => files.length === 4);
    await sleep(1500);
    const waiting = await i2.eval(FILES);
    assert.deepEqual(
      waiting.slice(2).map((file) => [file.status, file.preview]),
      [
        ["idle", null],
        ["idle", null],
      ],
      "not fetched without a click",
    );
    assert.equal((await i1.eval(FILES))[2].preview, null, "the sender's SVG has no preview either");
    await clickFile(i2, "idle");
    await waitFiles(i2, "I2 downloaded the SVG", (files) => files[2]?.status === "done");
    await sleep(500);
    assert.equal((await i2.eval(FILES))[2].preview, null, "a downloaded SVG has no preview");
    for (const page of [i1, i2]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
  });

  // Drags files over an element of the page and drops them there, as a person would from the desktop
  const dragFiles = (page, selector, names) =>
    page.eval(`(() => {
      const transfer = new DataTransfer();
      for (const name of ${JSON.stringify(names)}) {
        transfer.items.add(new File(["dropped " + name], name, { type: "text/plain" }));
      }
      window.__dragTransfer = transfer;
      document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
        new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    })()`);
  // Drops the dragged files, and tells whether the page kept the browser from opening them
  const dropFiles = (page, selector) =>
    page.eval(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      const options = { bubbles: true, cancelable: true, dataTransfer: window.__dragTransfer };
      target.dispatchEvent(new DragEvent("dragover", options));
      const drop = new DragEvent("drop", options);
      target.dispatchEvent(drop);
      return drop.defaultPrevented;
    })()`);

  await step("files: files dropped on the chat are attached, and a file dropped elsewhere does not open", async () => {
    const dropRoom = `${ORIGIN}/#DropRoom${Date.now()}`;
    const d1 = await newPage(cdp, "D1", { initExtra: withName("Dee") });
    const d2 = await newPage(cdp, "D2", { initExtra: withName("Eli") });
    await d1.goto(dropRoom);
    await d2.goto(dropRoom);
    await waitChat(d1, "D1 reaches D2", (c) => c.enabled && c.reach === "Reaches 1 of 1 people");
    await waitChat(d2, "D2 reaches D1", (c) => c.enabled && c.reach === "Reaches 1 of 1 people");
    await d1.click(tid("chat-toggle"));

    await dragFiles(d1, '[data-testid="chat-log"]', ["one.txt", "two.txt"]);
    await waitEval(d1, "the chat invites the drop", `$t("chat-drop") != null`, (shown) => shown === true);
    await d1.shot("chat-drop");
    assert.equal(await dropFiles(d1, '[data-testid="chat-log"]'), true);
    const own = await waitFiles(d1, "D1 shares both files", (files) => files.length === 2);
    assert.deepEqual(
      own.map((file) => [file.name, file.status]),
      [
        ["one.txt (15 B)", "own"],
        ["two.txt (15 B)", "own"],
      ],
    );
    assert.equal(await d1.eval(`$t("chat-drop") == null`), true, "the invitation goes with the drop");
    await waitFiles(d2, "D2 sees both files", (files) => files.length === 2 && files.every((f) => f.status === "idle"));

    // Outside the chat, the page keeps the browser from opening the file in place of the room, and attaches nothing
    await dragFiles(d1, '[data-testid="stage"]', ["three.txt"]);
    assert.equal(await dropFiles(d1, '[data-testid="stage"]'), true);
    await sleep(500);
    assert.equal((await d1.eval(FILES)).length, 2);
    for (const page of [d1, d2]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
  });

  // --- Voice call: one stream per participant in the call, to everyone in the room ---

  // The badges of the tiles and of the row of voices read as what they show (🖥 a screen, 📷 a camera, ☎ the voice
  // alone), the name and 🔇 for a muted microphone
  const BADGES = `[...$$t("tile-name"), ...$$t("voice-member")].map((badge) => ({ screen: "🖥", camera: "📷", voice: "☎" })[badge.dataset.kind] + badge.querySelector(".mantine-Badge-label").textContent + (badge.hasAttribute("data-muted") ? "🔇" : ""))`;
  const CALL = `(() => {
    const shown = (id) => $t(id) != null;
    const microphone = window.__microphones.at(-1)?.getAudioTracks()[0];
    const screenAudio = window.__captures.at(-1)?.getAudioTracks()[0];
    return {
      join: shown("call-join"),
      muted: shown("call-mute") ? $t("call-mute").getAttribute("aria-pressed") === "false" : null,
      leave: shown("call-leave"),
      badges: ${BADGES},
      audio: $$t("call-audio").map((audio) => ({
        playing: !audio.paused && audio.srcObject != null && audio.srcObject.getAudioTracks().length > 0,
        muted: audio.muted,
      })),
      microphone: microphone == null ? null : microphone.readyState === "live" ? (microphone.enabled ? "on" : "off") : "ended",
      microphoneCalls: window.__userMediaCalls,
      screenAudio: screenAudio == null ? null : screenAudio.enabled,
      echoChoice: shown("echo-choice"),
      calls: window.__roomState?.calls ?? [],
      notices: [...document.querySelectorAll('[data-testid^="notice-"]')].map((notice) => notice.dataset.testid),
    };
  })()`;
  const waitCall = async (page, desc, pred, timeout = 10000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await page.eval(CALL);
      if (pred(last)) return last;
      await sleep(100);
    }
    throw new Error(`${page.label}: timeout waiting for ${desc}\nlast call: ${JSON.stringify(last, null, 1)}`);
  };
  // The audio bytes that the page received on its open connections
  const AUDIO_BYTES = `(async () => {
    let total = 0;
    for (const pc of window.__pcs.filter((pc) => pc.connectionState !== "closed")) {
      (await pc.getStats()).forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") total += report.bytesReceived;
      });
    }
    return total;
  })()`;
  const waitAudioFlowing = async (page, desc) => {
    const end = Date.now() + 15000;
    let before = await page.eval(AUDIO_BYTES);
    while (Date.now() < end) {
      await sleep(500);
      const now = await page.eval(AUDIO_BYTES);
      if (now > before && before > 0) return;
      before = now;
    }
    throw new Error(`${page.label}: timeout waiting for ${desc}`);
  };
  const callRoom = `${ORIGIN}/#CallRoom${Date.now()}`;
  let k1;
  let k2;

  await step("call: joining sends the microphone to everyone in the room, also to those outside the call", async () => {
    k1 = await newPage(cdp, "K1", { initExtra: withName("Kim") });
    k2 = await newPage(cdp, "K2", { initExtra: withName("Lee") });
    await k1.goto(callRoom);
    await k2.goto(callRoom);
    await waitCall(k1, "K1 can join", (c) => c.join && c.badges.length === 0);
    await waitCall(k2, "K2 can join", (c) => c.join);
    assert.equal(await k1.eval("window.__userMediaCalls"), 0, "no microphone before joining");

    await k1.click(tid("call-join"));
    const joined = await waitCall(k1, "K1 in the call", (c) => c.leave && c.badges.length === 1);
    assert.deepEqual(joined.badges, ["☎You"]);
    assert.equal(joined.muted, false, "not muted when joining");
    assert.equal(joined.microphone, "on");
    assert.equal(joined.join, false);
    assert.deepEqual(await k1.eval("window.__userMediaConstraints.audio"), {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    assert.deepEqual(joined.audio, [], "the own microphone does not play");

    const heard = await waitCall(k2, "K2 plays Kim's microphone", (c) => c.audio.length === 1 && c.audio[0].playing);
    assert.deepEqual(heard.badges, ["☎Kim"]);
    assert.equal(heard.join, true, "K2 is not in the call");
    await waitAudioFlowing(k2, "audio from K1");
    await k2.openMenu();
    const badges = await k2.eval(`$$t("participant").map((row) => row.textContent)`);
    await k2.closeMenu();
    assert.ok(
      badges.some((text) => text.startsWith("Kim") && text.includes("in call")),
      JSON.stringify(badges),
    );
  });

  await step("call: a second participant hears the first, and the first hears them", async () => {
    await k2.click(tid("call-join"));
    await waitCall(k1, "K1 plays Lee's microphone", (c) => c.audio.length === 1 && c.audio[0].playing);
    await waitAudioFlowing(k1, "audio from K2");
    const both = await waitCall(k2, "K2 in the call", (c) => c.leave && c.badges.length === 2);
    assert.deepEqual(both.badges, ["☎Kim", "☎You"]);
    assert.equal(both.audio.length, 1);
  });

  await step("call: muting sends silence and shows a mark to the others", async () => {
    await k1.click(tid("call-mute"));
    const muted = await waitCall(k1, "K1 muted", (c) => c.muted === true);
    assert.equal(muted.microphone, "off");
    await waitCall(k2, "K2 sees Kim muted", (c) => c.badges[0] === "☎Kim🔇");
    await k1.click(tid("call-mute"));
    assert.equal((await waitCall(k1, "K1 unmuted", (c) => c.muted === false)).microphone, "on");
    await waitCall(k2, "K2 sees Kim unmuted", (c) => c.badges[0] === "☎Kim");
  });

  await step("call: after a WebSocket drop, the page joins again with the same microphone", async () => {
    // Kim joined first. A clean close removes a participant who does not present, so Kim comes back with a new ID.
    const before = (await k2.eval("window.__roomState.calls"))[0].streamId;
    await k1.eval("window.__sockets.at(-1).close()");
    await waitCall(
      k2,
      "K2 sees Kim's new stream",
      (c) => c.calls.length === 2 && !c.calls.some((call) => call.streamId === before) && c.badges.includes("☎Kim"),
      15000,
    );
    const back = await waitCall(k1, "K1 in the call again", (c) => c.leave && c.badges.length === 2);
    assert.equal(back.microphoneCalls, 1, "the microphone was not asked for again");
    assert.equal(back.microphone, "on");
    await waitCall(k2, "K2 plays Kim again", (c) => c.audio.length === 1 && c.audio[0].playing);
    await waitAudioFlowing(k2, "audio from K1 after the reconnect");
  });

  await step("call: leaving stops the microphone and its sound; a reload leaves the call", async () => {
    await k1.click(tid("call-leave"));
    const left = await waitCall(k1, "K1 left", (c) => c.join && c.badges.length === 1);
    assert.equal(left.microphone, "ended");
    assert.deepEqual(left.badges, ["☎Lee"]);
    const k2State = await waitCall(k2, "K2 no longer plays Kim", (c) => c.audio.length === 0);
    assert.deepEqual(k2State.badges, ["☎You"]);
    await k2.reload();
    await waitCall(k2, "K2 out of the call after the reload", (c) => c.join && c.badges.length === 0);
    await waitCall(k1, "K1 sees nobody in the call", (c) => c.badges.length === 0 && c.audio.length === 0);
  });

  await step("call: a refused microphone shows a notice and does not join", async () => {
    await k1.eval("window.__denyMicrophone = true");
    await k1.click(tid("call-join"));
    const refused = await waitCall(k1, "K1 notice", (c) => c.notices.includes("notice-microphone-denied"));
    assert.equal(refused.join, true);
    assert.equal(refused.leave, false);
    await sleep(300);
    assert.deepEqual((await k1.eval(CALL)).calls, []);
    await k1.eval("window.__denyMicrophone = false");
    await k1.closeNotice("notice-microphone-denied");
  });

  await step("call: shared sound that would carry the call back stays off until the presenter chooses", async () => {
    await k2.click(tid("call-join"));
    await waitCall(k1, "K1 plays Lee", (c) => c.audio.length === 1 && c.audio[0].playing);
    // A screen with system sound, without restrictOwnAudio: it would carry the call that K1 plays
    await presentAs(k1, "Kim", { audio: true, surface: "monitor" });
    let s = await waitCall(k1, "K1 asked", (c) => c.echoChoice);
    assert.equal(s.screenAudio, false, "the shared sound is off before the choice");
    assert.equal(s.audio[0].muted, false, "the call plays meanwhile");
    await k1.shot("echo-choice");

    await k1.click(tid("echo-choice-screen"));
    s = await waitCall(k1, "K1 shares the sound", (c) => !c.echoChoice && c.screenAudio === true);
    assert.equal(s.audio[0].muted, true, "the call is muted on this page");

    // A tab only has its own sound: no question, and the call plays again
    await switchTo(k1, { audio: true, surface: "browser" });
    s = await waitCall(k1, "K1 shares a tab", (c) => c.screenAudio === true && !c.echoChoice && !c.audio[0].muted);

    // A new screen asks again
    await switchTo(k1, { audio: true, surface: "monitor" });
    s = await waitCall(k1, "K1 asked again", (c) => c.echoChoice && c.screenAudio === false);
    await k1.click(tid("echo-choice-call"));
    s = await waitCall(k1, "K1 keeps the call", (c) => !c.echoChoice);
    assert.equal(s.screenAudio, false);
    assert.equal(s.audio[0].muted, false);

    // Without anyone else in the call, the sound goes out; when the call starts again, the choice stays
    await k2.click(tid("call-leave"));
    await waitCall(k1, "K1 shares the sound with no call", (c) => c.screenAudio === true && c.audio.length === 0);
    await k2.click(tid("call-join"));
    s = await waitCall(k1, "K1 off again", (c) => c.screenAudio === false && c.audio.length === 1);
    assert.equal(s.echoChoice, false, "the choice was made for this screen");
    for (const page of [k1, k2]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
  });

  // --- Video: the cameras of the call, on the stage beside the screens ---

  const VIDEO = `(() => {
    const camera = window.__cameras.at(-1)?.getVideoTracks()[0];
    const button = $t("call-camera");
    return {
      cameraButton: button == null ? null : { pressed: button.getAttribute("aria-pressed") === "true", disabled: button.disabled },
      camera: camera == null ? null : camera.readyState,
      tiles: $$t("tile").filter((tile) => tile.dataset.kind === "camera").map((tile) => {
        const video = tile.querySelector("video");
        return {
          name: tile.querySelector('[data-testid="tile-name"]').textContent,
          self: tile.hasAttribute("data-self"),
          playing: video.videoWidth > 0 && !video.paused,
          muted: video.muted,
          mirrored: getComputedStyle(video).transform !== "none",
        };
      }),
      badges: ${BADGES},
      speaking: [...$$t("tile-name"), ...$$t("voice-member")].filter((badge) => badge.hasAttribute("data-speaking")).map((badge) => badge.querySelector(".mantine-Badge-label").textContent),
      notices: [...document.querySelectorAll('[data-testid^="notice-"]')].map((notice) => notice.dataset.testid),
    };
  })()`;
  const waitVideo = async (page, desc, pred, timeout = 15000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await page.eval(VIDEO);
      if (pred(last)) return last;
      await sleep(100);
    }
    throw new Error(`${page.label}: timeout waiting for ${desc}\nlast video: ${JSON.stringify(last, null, 1)}`);
  };
  const joinCall = async (page) => {
    await page.click(tid("call-join"));
    await waitCall(page, `${page.label} in the call`, (c) => c.leave);
  };
  const videoRoom = `${ORIGIN}/#VideoRoom${Date.now()}`;
  let v1;
  let v2;
  let v3;

  await step(
    "video: a camera shows as a tile to everyone, also outside the call; the own one is mirrored",
    async () => {
      v1 = await newPage(cdp, "V1", { initExtra: withName("Vic") });
      v2 = await newPage(cdp, "V2", { initExtra: withName("Wes") });
      v3 = await newPage(cdp, "V3", { initExtra: withName("Xia") });
      for (const page of [v1, v2, v3]) {
        await page.goto(videoRoom);
        await waitCall(page, `${page.label} can join`, (c) => c.join);
      }
      assert.equal((await v1.eval(VIDEO)).cameraButton, null, "no camera button outside the call");
      await joinCall(v1);
      assert.deepEqual((await v1.eval(VIDEO)).cameraButton, { pressed: false, disabled: false }, "the camera is off");
      await v1.click(tid("call-camera"));
      const own = await waitVideo(v1, "V1 shows its camera", (v) => v.tiles.length === 1 && v.tiles[0].playing);
      assert.deepEqual(own.tiles[0], { name: "You", self: true, playing: true, muted: true, mirrored: true });
      assert.deepEqual(own.cameraButton, { pressed: true, disabled: false });
      assert.deepEqual(await v1.eval("window.__userMediaConstraints.video"), {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 24 },
      });
      for (const page of [v2, v3]) {
        const seen = await waitVideo(page, `${page.label} sees Vic's camera`, (v) => v.tiles[0]?.playing === true);
        assert.deepEqual(seen.tiles, [{ name: "Vic", self: false, playing: true, muted: true, mirrored: false }]);
        assert.deepEqual(seen.badges, ["📷Vic"]);
      }
      await v2.shot("camera");
    },
  );

  await step("video: turning the camera off removes the tile and stops the camera", async () => {
    await v1.click(tid("call-camera"));
    const off = await waitVideo(v1, "V1 camera off", (v) => v.tiles.length === 0 && v.camera === "ended");
    assert.deepEqual(off.cameraButton, { pressed: false, disabled: false });
    await waitVideo(v2, "V2 no longer sees Vic's camera", (v) => v.tiles.length === 0 && v.badges[0] === "☎Vic");
    await v1.click(tid("call-camera"));
    await waitVideo(v2, "V2 sees Vic's camera again", (v) => v.tiles[0]?.playing === true);
  });

  await step("video: a camera beyond the limit of the room is refused and stopped", async () => {
    await joinCall(v2);
    await v2.click(tid("call-camera"));
    await waitVideo(v3, "V3 sees two cameras", (v) => v.tiles.length === 2 && v.tiles.every((tile) => tile.playing));
    await joinCall(v3);
    await v3.click(tid("call-camera"));
    const refused = await waitVideo(v3, "V3 refused", (v) => v.notices.includes("notice-cameras-full"));
    await waitVideo(v3, "V3's camera stopped", (v) => v.camera === "ended" && v.cameraButton?.pressed === false);
    assert.equal(refused.tiles.filter((tile) => tile.self).length, 0);
    await sleep(500);
    assert.equal((await v1.eval(VIDEO)).tiles.length, 2, "V1 still sees two cameras");
    // Xia is in the call without a tile, so Xia shows in the row of voices under the stage
    await waitVideo(
      v1,
      "V1 sees Xia by voice",
      (v) => JSON.stringify(v.badges) === JSON.stringify(["📷You", "📷Wes", "☎Xia"]),
    );
  });

  await step("call: who speaks is marked, but not while muted", async () => {
    // Chrome's fake microphone beeps
    await waitVideo(v1, "V1 sees Wes speak", (v) => v.speaking.includes("Wes"), 20000);
    await v2.click(tid("call-mute"));
    await waitCall(v1, "V1 sees Wes muted", (c) =>
      c.badges.some((badge) => badge.includes("Wes") && badge.includes("🔇")),
    );
    await sleep(1000);
    for (let i = 0; i < 10; i++) {
      assert.ok(!(await v1.eval(VIDEO)).speaking.includes("Wes"), "a muted participant does not speak");
      await sleep(200);
    }
    await v2.click(tid("call-mute"));
  });

  await step(
    "call: the menu lists the devices; another microphone replaces the track on the same connections",
    async () => {
      await v2.openMenu();
      const options = await waitEval(
        v2,
        "V2 lists the devices",
        `[...$t("device-microphone").options].map((option) => [option.value, option.textContent])`,
        (list) => list.length >= 2 && list.slice(1).every(([value, label]) => value !== "" && label !== ""),
      );
      assert.equal(options[0][0], "", "the default comes first");
      assert.ok(await v2.eval(isShown("menu-devices")));
      const cameras = await v2.eval(`$t("device-camera").options.length`);
      assert.ok(cameras >= 2, "the fake camera is listed");
      const pcs = await v2.eval("window.__pcs.length");
      const replaced = await v2.eval("window.__replaced.length");
      const chosen = options.at(-1)[0];
      await v2.type(tid("device-microphone"), chosen);
      await waitEval(v2, "V2 uses another microphone", "window.__microphones.length", (n) => n === 2);
      await waitEval(
        v2,
        "the new microphone replaces the track",
        `window.__replaced.slice(${replaced}).filter((entry) => entry.kind === "audio").length`,
        (n) => n > 0,
      );
      assert.equal(await v2.eval("window.__pcs.length"), pcs, "no new connection");
      assert.equal(await v2.eval("window.__microphones[0].getAudioTracks()[0].readyState"), "ended");
      assert.deepEqual(await v2.eval("window.__userMediaConstraints.audio.deviceId"), { ideal: chosen });
      assert.equal(JSON.parse(await v2.eval(`localStorage.getItem("screensy.devices")`)).microphone, chosen);
      await waitCall(v1, "V1 still plays Wes", (c) => c.audio.length === 2 && c.audio.every((audio) => audio.playing));
      await v2.closeMenu();
    },
  );

  await step("call: the statistics list the connections of the call", async () => {
    await v2.openMenu();
    const stats = await waitEval(
      v2,
      "V2's call statistics",
      `$$t("stats-entry").map((e) => e.querySelector('[data-testid="stats-name"]').textContent + " " + e.querySelector('[data-testid="stats-direction"]').textContent)`,
      (list) => list.includes("Vic (call) receiving") && list.includes("Vic (call) sending"),
    );
    assert.ok(stats.includes("Xia (call) receiving"), JSON.stringify(stats));
    await v2.closeMenu();
    for (const page of [v1, v2, v3]) {
      await cdp.send("Target.closeTarget", { targetId: page.targetId });
    }
  });

  // --- Cloudflare: the Worker, Static Assets and the Durable Object in wrangler dev ---

  if (process.env.SKIP_CLOUDFLARE) {
    console.log("skip the Cloudflare checks (SKIP_CLOUDFLARE)");
  } else {
    const CF_ORIGIN = `http://localhost:${WRANGLER_PORT}`;

    await step("wrangler dev serves screensy-cloudflare", async () => {
      // test:e2e has built the website; build.mjs copies it into public/
      execFileSync("node", ["build.mjs"], { cwd: join(REPO, "screensy-cloudflare"), stdio: "inherit" });
      run("pnpm", ["exec", "wrangler", "dev", `--port=${WRANGLER_PORT}`, "--show-interactive-dev-session=false"], {
        cwd: join(REPO, "screensy-cloudflare"),
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        detached: true,
      });
      await waitHttp(`${CF_ORIGIN}/screensy.css`, 60000);
    });

    await step(
      "the Worker picks the language like the Go server, and Static Assets serve the other files",
      async () => {
        const languageOf = async (url, acceptLanguage) => {
          const r = await fetch(url, { headers: { "Accept-Language": acceptLanguage } });
          assert.equal(r.status, 200);
          return { lang: /<html lang="(\w+)">/.exec(await r.text())?.[1], headers: r.headers };
        };
        for (const acceptLanguage of ["ja,en;q=0.8", "en-US", "fr", "fr, ja-JP;q=0.5", "en;q=0.2, ja;q=0.9", ""]) {
          for (const path of ["/", "/index.html"]) {
            const worker = await languageOf(`${CF_ORIGIN}${path}`, acceptLanguage);
            const go = await languageOf(`http://localhost:8080${path}`, acceptLanguage);
            assert.equal(worker.lang, go.lang, `"${acceptLanguage}" on ${path}`);
            assert.equal(worker.headers.get("cache-control"), "no-cache");
            assert.match(worker.headers.get("vary") ?? "", /Accept-Language/i);
          }
        }
        const script = await fetch(`${CF_ORIGIN}/screensy.js`);
        assert.equal(await script.text(), readFileSync(join(REPO, "screensy-website", "screensy.js"), "utf8"));
        assert.equal((await fetch(`${CF_ORIGIN}/screensy.css`)).status, 200);
      },
    );

    await step("through the Durable Object, a viewer gets the presentation", async () => {
      const presenter = await newPage(cdp, "W1");
      await presenter.goto(`${CF_ORIGIN}/`);
      const s = await presenter.waitFor("W1 start dialog", (s) => s.dialogOpen, 15000);
      await presenter.submitDialog("Wendy");
      await presenter.waitFor("W1 presenting", (s) => s.videoLocal);
      const viewer = await newPage(cdp, "W2");
      await viewer.goto(`${CF_ORIGIN}/${s.hash}`);
      await viewer.waitFor("W2 video through the Worker's signaling", (s) => s.videoPlaying, 20000);
      // The mesh of the chat is signaled through the Durable Object too
      await waitChat(viewer, "W2 reaches W1", (c) => c.enabled && c.reach === "Reaches 1 of 1 people", 20000);
      await pressEnter(viewer, "through the Worker");
      await waitChat(presenter, "W1 gets the chat message", (c) => texts(c).includes("Guest 2: through the Worker"));
      // And the call
      await viewer.click(tid("call-join"));
      await waitCall(presenter, "W1 plays W2's microphone", (c) => c.audio.length === 1 && c.audio[0].playing, 20000);
      for (const page of [presenter, viewer]) {
        await cdp.send("Target.closeTarget", { targetId: page.targetId });
      }
    });
  }

  console.log(results.every(Boolean) ? "all passed" : "some failed");
};

main()
  .catch((e) => {
    if (!results.length || results.every(Boolean)) console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    setTimeout(() => process.exit(), 200);
  });
