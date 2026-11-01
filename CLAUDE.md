# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Screensy is a peer-to-peer (WebRTC) screen sharing app. The video stream goes directly from the broadcaster's browser to each viewer's browser. The server side only does signaling and serves static files.

The repository is a pnpm workspace with two packages, plus deployment config at the root:

- `screensy-rendezvous/`: WebSocket signaling server (TypeScript on Node, `ws` library, port 4000). It is a single file, `server.ts`. Node runs it directly with type stripping, so it is never compiled.
- `screensy-website/`: Static file server written in Go (port 8080). It also serves the browser client `screensy.ts` and `styles.css`. `tsc` compiles the client to `screensy.js` next to the source, without a bundler.
- Root: `docker-compose.yaml` (rendezvous, website, Caddy reverse proxy, coturn STUN/TURN), `Caddyfile`, `turnserver.conf`.

The toolchain versions are pinned in `mise.toml`: Node, pnpm, Go and prek.

## Commands

```sh
mise install && pnpm install          # set up the toolchain and dependencies
pnpm check                            # Biome format + lint with fixes (TS, JSON, CSS, Markdown, YAML; HTML is lint-only)
pnpm lint                             # Biome without writing changes
pnpm typecheck                        # tsc --noEmit in both packages
pnpm --filter screensy-website build  # compile screensy.ts -> screensy.js
pnpm test:protocol                    # protocol checks against the rendezvous server (port 4000)
pnpm test:e2e                         # browser checks in headless Chrome (needs Go and Chrome; ports 4000, 8080, 8090, 9333)

pnpm --filter screensy-rendezvous start            # ws://localhost:4000
cd screensy-website && go run .                    # http://localhost:8080 (must run from screensy-website/, it serves ".")
cd screensy-website && go vet ./... && gofmt -l .  # Go checks

docker compose build    # the build context is the repo root (the lockfile lives there)
docker compose up -d
```

`--filter` matches the `name` in each package's `package.json`, not the directory name. WebRTC requires HTTPS outside `localhost`, so test a real deployment behind Caddy.

### Tests

The two scripts in `tests/` are plain Node ESM with no dependencies of their own. They start what they need and stop it when they finish. They are not run in CI or by the git hooks; run them after changing the protocol, the client or the translations.

- `tests/protocol.mjs` starts `server.ts` with short timers (`SCREENSY_*_MS`) and checks the protocol with WebSocket clients: joining, takeover, the grace periods, resuming, socket replacement, signal relay validation, the heartbeat and room deletion. It borrows `ws` from `screensy-rendezvous`, because it needs `terminate()` and `autoPong`.
- `tests/e2e.mjs` builds and starts the website, the rendezvous server and a proxy on port 8090 that routes like the Caddyfile, then drives headless Chrome over CDP. `getDisplayMedia` returns a canvas stream, because headless Chrome cannot accept the screen picker. Chrome keeps its default mDNS host candidates: turning them off hid a real connection bug once. The proxy can break a page's WebSocket without a close frame, for pages that set the cookie `e2e=<tag>`. The init script records every `RTCPeerConnection` (`__pcs`) and every `replaceTrack` call (`__replaced`), and `__replaceHook` can delay or fail `replaceTrack` for a test. `__nextCapture` sets the size, color and audio of the next fake capture. `CHROME` sets the Chrome binary, `SHOTS=<dir>` saves screenshots and `DEBUG=1` prints the server output.

## Tooling conventions

- Biome config follows `~/Workspace/templates` (`assets/biome/default.json`): 2-space indent, line width 120.
  - `screensy-website/biome.json` is a nested config (`"extends": "//"`) that adds the non-React overrides from the template's `react.json`.
  - Fix lint violations in code instead of disabling rules.
- TypeScript 7 (native compiler). The rendezvous tsconfig sets `erasableSyntaxOnly` and `verbatimModuleSyntax`, which Node's type stripping requires. Do not use enums, namespaces or parameter properties there, and use `import type` for type-only imports.
- The website tsconfig must keep emitting a classic script. `screensy.ts` has no `import`/`export`, and the HTML loads it with a plain `<script>`.
- prek git hooks (`prek.toml`) are installed by the `prepare` script on `pnpm install`. On commit, they run the builtin whitespace/merge-conflict/large-file checks, `biome check --write` and `gofmt`. Run them manually with `mise exec -- prek run --all-files`.
- Claude Code hooks in `.claude/`, adapted from the templates repo, need `jq`:
  - `post-edit.sh` runs `biome check --write` or `gofmt` on each edited file.
  - `stop-check.sh` blocks the stop when Biome, `pnpm -r typecheck`, `go vet` or `gofmt` report problems.

## Architecture

### Signaling protocol (shared between `server.ts` and `screensy.ts`)

The message types are **duplicated** in `screensy-rendezvous/server.ts` and `screensy-website/screensy.ts`. If you change the protocol, update both files. Messages are JSON with a `type` field. There are no fixed roles: anyone in a room can present, and the design allows several presenters at once, but the server limits it with `MAX_PRESENTERS = 1`.

1. The client connects to the WebSocket at the same host and path as the page and sends `join` with `roomId` (the URL hash, lowercased by the client), `name` and an optional `resumeToken`. The server answers `welcome` (`selfId`, `connectionId`, `resumeToken`) and then sends `roomstate` to everyone.
2. `roomstate` is the whole state of the room: `participants` (`id`, `connectionId`, `name`, `connected`) and `presenters` (`participantId`, `streamId`, `hidden`, `status: "live" | "reconnecting"`, `disconnectReason: "left" | "lost" | null`, `graceRemainingMs: number | null`). The server sends it after every change, and clients reconcile against it.
3. A client captures its screen first and then sends `present`. The server assigns a new `streamId`, answers `presentaccepted` (before the next `roomstate`), and removes the oldest presenter when the limit is reached (this is how a takeover works). `present` with `resume: true` is only accepted while the sender still holds a seat; otherwise the server answers `presentrejected`. `stoppresenting` frees the seat. `streamstate` sets `hidden` for the sender's stream (the "Hide screen" button). The server resets `hidden` on every `present`, so a client that resumes while hidden sends it again.
4. SDP/ICE goes through `signal`. The sender sets `to`, `toConnection` and `streamId`, and the server relays it with `from` and `fromConnection` only if the recipient is connected with that `connectionId`, the stream is active, and the sender or the recipient is the presenter of that stream. `kind` is `offer | answer | candidate`. WebRTC connections are keyed by `(participantId, connectionId)`, so a new `connectionId` means "rebuild the connections".
5. Reconnection: the resume token lives in `sessionStorage` (`screensy.resume.<roomId>`). A presenter whose socket closes keeps the seat as `reconnecting`; other participants are removed at once. The grace period depends on the close code: a clean close (1000, 1001, 1005: a reload or a closed tab, which look the same) gives `disconnectReason: "left"` and `LEFT_GRACE_MS` (30 s), anything else (1006 for a broken connection or a missed ping) gives `"lost"` and `LOST_GRACE_MS` (5 min). `graceRemainingMs` is the time left, sent as a duration so that the clocks need not agree. A `join` with a known token takes over that participant, even if its old socket is still open: the old socket gets `replaced` and is closed, and its late `close` event is ignored. Rejoining stops the grace timer (`graceRemainingMs: null`): the seat then stays until the participant resumes or frees it, or someone takes over. A room is deleted when it has no participants left, including those in the grace period.

The server pings every client every 15 s and terminates those that did not answer. `SCREENSY_LEFT_GRACE_MS`, `SCREENSY_LOST_GRACE_MS` and `SCREENSY_PING_INTERVAL_MS` shorten the timers for testing. Incoming messages are parsed as `unknown` and validated with the `isObject` / `instanceOf*` type guards. Invalid messages are silently dropped.

### Browser client (`screensy.ts`)

`main()` creates a random room name in the hash if there is none (with `history.replaceState`, so the page does not reload) and checks browser support. `RoomController` then joins the room and reconciles every `roomstate`:

- `SignalingConnection` reconnects with backoff and drops messages while disconnected. After a reconnect, `welcome` and the next `roomstate` resynchronize everything.
- `OutgoingStream` is this client's presentation: one `RTCPeerConnection` per recipient. It has no `streamId` while awaiting `presentaccepted`. Losing the own entry in `presenters` means the seat was taken over.
  - Every connection has exactly one video and one audio transceiver (`sendonly`), even for a capture without audio, so that switching the screen (`replaceCapture`) and hiding it (`setHidden`) never renegotiate.
  - The captured tracks are sent as they are, and the preview shows the same tracks. Hiding disables them, so the viewers get black frames and silence, and the presenter's preview turns black too: both sides see the same. A switch disables the new tracks before any `replaceTrack` when hidden, and rolls every connection back to the current capture if one of them rejects the new tracks.
- `IncomingStream` is one received stream per `streamId`. `PeerLink` holds back ICE candidates until the remote description is set.
- `Ui` wraps the elements. The start/resume dialog and the "Switch screen" button must call `getDisplayMedia` synchronously in their handlers, so that the click still counts as a user activation.

The ICE servers are hard-coded to STUN/TURN on `location.hostname` with credentials `screensy:screensy`. These must match `turnserver.conf` (`user=screensy:screensy`, `realm=screensy`).

### Translations / i18n

`screensy-website/translations/` has two full copies of the index page: `en.html` and `ja.html`. `main.go` loads them at startup and parses each filename as a BCP 47 tag (`language.MustParse`, so a bad filename panics). It serves the best match for `Accept-Language` on `/` and `/index.html`, with `en.html` as the fallback. All other paths go to `http.FileServer(".")`.

`screensy.ts` finds elements by ID (`getElement`, `showPopup`, the `status-*` and `notice-*` elements, `[data-mode]` in the dialog), so both files must keep the same element IDs and structure. Only the text should change. Names are inserted into `<span class="name-slot">` elements, and `#text-anonymous` holds the name shown for someone without one. The time left of a grace period goes into `<span class="countdown-slot">`, inside a `.countdown` element that is hidden when there is no time limit.

### Deployment notes

- Caddy routes requests that carry WebSocket `Upgrade` headers to `rendezvous:4000` and everything else to `website:8080`.
- Before deploying, set the domain on the first line of `Caddyfile` and `external-ip` in `turnserver.conf`.
- Node 25+ images do not ship corepack, so the Dockerfiles install pnpm with `npm install --global pnpm@<version>`. Keep that version in sync with `mise.toml` and `packageManager`.
