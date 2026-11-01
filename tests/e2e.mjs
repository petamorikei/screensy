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
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) { super(...args); window.__sockets.push(this); }
  };
  window.__captures = [];
  navigator.mediaDevices.getDisplayMedia = async () => {
    if (window.__denyCapture) throw new DOMException("denied", "NotAllowedError");
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    let i = 0;
    setInterval(() => { context.fillStyle = "hsl(" + ((i++ * 15) % 360) + " 80% 50%)"; context.fillRect(0, 0, 640, 360); }, 50);
    const stream = canvas.captureStream(20);
    window.__captures.push(stream);
    return stream;
  };
})();
`;

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
    warning: document.getElementById("present-takeover-warning").classList.contains("hidden") ? null : document.getElementById("present-takeover-warning").textContent.trim().replace(/\\s+/g, " "),
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

async function main() {
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
    assert.equal(s.warning, null);
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
    assert.deepEqual(s.toolbar, ["present-button"]);
    await a.waitFor("viewer count 1", (s) => s.viewers === "1");
    await b.shot("3-viewing-ja");
    await a.shot("3b-presenting-1-viewer-en");
  });

  await step("viewer takes over after the confirmation dialog", async () => {
    await b.click("#present-button");
    const s = await b.waitFor("takeover dialog", (s) => s.dialogOpen);
    assert.match(s.warning, /Alice/);
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
    assert.deepEqual(sa.toolbar, ["present-button"]);
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
    assert.equal(s.warning, null);
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
    assert.match(sb.warning, /Alice/);
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
    assert.deepEqual(s.toolbar, ["present-button"]);
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
