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

There is no test suite.

```sh
mise install && pnpm install          # set up the toolchain and dependencies
pnpm check                            # Biome format + lint with fixes (TS, JSON, CSS, Markdown, YAML; HTML is lint-only)
pnpm lint                             # Biome without writing changes
pnpm typecheck                        # tsc --noEmit in both packages
pnpm --filter screensy-website build  # compile screensy.ts -> screensy.js

pnpm --filter screensy-rendezvous start            # ws://localhost:4000
cd screensy-website && go run .                    # http://localhost:8080 (must run from screensy-website/, it serves ".")
cd screensy-website && go vet ./... && gofmt -l .  # Go checks

docker compose build    # the build context is the repo root (the lockfile lives there)
docker compose up -d
```

`--filter` matches the `name` in each package's `package.json`, not the directory name. WebRTC requires HTTPS outside `localhost`, so test a real deployment behind Caddy.

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

The message types are **duplicated** in `screensy-rendezvous/server.ts` and `screensy-website/screensy.ts`. If you change the protocol, update both files. Messages are JSON with a `type` field:

1. The client connects to the WebSocket at the same host and path as the page and sends `join` with `roomId` (the URL hash, lowercased by the client).
2. The **first client to join a room becomes the broadcaster** (receives `broadcast`). Everyone after that is a viewer (`view`). The room is destroyed when the broadcaster disconnects, and viewers get `broadcasterdisconnected`.
3. The server gives each viewer an incrementing numeric string `viewerId` and notifies the broadcaster (`viewer`, `viewerdisconnected`). The broadcaster sends `requestviewers` after setup to receive the current viewer list.
4. SDP/ICE is relayed: the broadcaster sends `webrtcbroadcaster` (with `viewerId`), and the server forwards it to that viewer as `webrtcviewer`. The reverse direction works the same way, with the server adding the `viewerId`. `kind` is `offer | answer | candidate`.

On the server, incoming messages are parsed as `unknown` and validated with the `isObject` / `instanceOf*` type guards. Invalid messages are silently dropped.

### Browser client (`screensy.ts`)

`main()` creates a random room name in the hash if there is none, checks browser support (showing popups when something is missing), then calls `Room.join()`. `Room` creates either a `Broadcaster` (one `RTCPeerConnection` per viewer, with the `getDisplayMedia` stream) or a `Viewer` (one connection to the broadcaster).

The ICE servers are hard-coded to STUN/TURN on `location.hostname` with credentials `screensy:screensy`. These must match `turnserver.conf` (`user=screensy:screensy`, `realm=screensy`).

### Translations / i18n

`screensy-website/translations/<lang-tag>.html` are full copies of the index page, one per language. `main.go` loads them all at startup and parses each filename as a BCP 47 tag (`language.MustParse`, so a bad filename panics). It serves the best match for `Accept-Language` on `/` and `/index.html`, with `en.html` as the fallback. All other paths go to `http.FileServer(".")`.

`screensy.ts` finds popups by element ID (`showPopup("access-denied")`, etc.), so every translation file must keep the same element IDs and structure as `en.html`. Only the text should change.

To add a language:

1. Copy `en.html` to a new file named after the language tag and translate it.
2. Add an entry to `CHANGELOG.md` (Keep a Changelog format) and `CONTRIBUTORS.md`.

### Deployment notes

- Caddy routes requests that carry WebSocket `Upgrade` headers to `rendezvous:4000` and everything else to `website:8080`.
- Before deploying, set the domain on the first line of `Caddyfile` and `external-ip` in `turnserver.conf`.
- Node 25+ images do not ship corepack, so the Dockerfiles install pnpm with `npm install --global pnpm@<version>`. Keep that version in sync with `mise.toml` and `packageManager`.
