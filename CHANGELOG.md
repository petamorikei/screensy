# Changelog

All notable changes to the screensy project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

## Unreleased

### Added

-   Screensy runs on Cloudflare Workers, in the free plan: the new
    "screensy-cloudflare" package serves the page from a Worker and runs the
    rendezvous server in a Durable Object (`pnpm --filter screensy-cloudflare
    run cf:deploy`).
-   A GitHub Actions workflow deploys to Cloudflare Workers after the lint,
    the type checks and the protocol tests pass. It runs when started by hand
    or for a version tag, because a deploy ends every room.
-   The STUN servers can be chosen with an environment variable of the
    rendezvous server (`SCREENSY_STUN_URLS`). The default is Cloudflare's
    public STUN server.
-   A quick start at the top of the README, for three setups: inside a
    tailnet, public with Tailscale Funnel, and on Cloudflare Workers. For
    Tailscale, "docker-compose.tailscale.yaml" and "Caddyfile.tailscale" make
    Caddy serve plain HTTP on localhost:80 only, selected with `COMPOSE_FILE`
    in ".env".
-   Anyone in a room can start presenting at any time with the "Present"
    button. Up to four people can present at once, shown side by side; a
    click enlarges one of them. When the room is full of presenters, the start
    dialog asks whom to take over from. The room no longer closes when the presenter leaves.
-   Presenters enter a display name, which screensy remembers for the next
    time. The name fields turn off the browser's own autofill. Status messages
    and notices show the presenter's name, for example when someone takes
    over.
-   A "Stop presenting" button. Presenting also stops when the browser's own
    "Stop sharing" control ends the capture.
-   A "Switch screen" button lets the presenter choose another screen,
    window or tab without interrupting the viewers.
-   A "Blur screen" button blurs the presentation for the viewers and in the
    presenter's preview. A slider next to it sets the strength, shown as a
    number, which the browser remembers; the strength follows the pixel
    density of the screen. It is available in Chrome and Edge, and keeps working while the
    tab is in the background.
-   A "Hide screen" button turns the presentation black and silent, for the
    viewers and in the presenter's own preview alike. Viewers see that the
    presenter has hidden their screen.
-   A menu with quality settings for presenting: the frame rate (60 fps by
    default, or 30), the resolution (the original one or a common height),
    the maximum bitrate (from 1 to 100 Mbps), and the priority when the
    connection is slow (resolution, frame rate or a balance). The browser
    remembers them, and changes apply at once.
-   Each presentation has its own mute and full-screen buttons. While a
    presenter shares sound that may contain the other presenters' sound, they
    are muted on that presenter's page, so that it does not echo.
-   A chat for everyone in the room, opened with the "Chat" button, which
    counts the unread messages. The messages go directly between the
    browsers, not through the server. Someone who joins later gets the
    earlier messages from the others, a lost message is fetched again, and
    every page shows the messages in the same order. The history survives a
    reload, and is gone when everyone has left the room. The panel shows how
    many of the others the chat reaches.
-   A voice call: "Join call" asks for the microphone, and everyone in the
    room hears the people in the call, directly from their browsers. The
    name on each screen and camera shows whether it is a screen or a camera,
    and whether that person is muted or speaking in the call; a row under the
    stage shows those in the call by voice alone. After a lost connection to
    the server, the page joins the call again by itself. When a presenter
    shares sound that would carry the call back to everyone, the shared sound
    stays off until they choose between it and hearing the call.
-   Video in the call: "Turn camera on" shows the camera to everyone in the
    room, beside the shared screens. Up to four cameras can be on at once
    (`SCREENSY_MAX_CAMERAS`).
-   The menu lets you choose the microphone, the camera and the speaker of
    the call; a new choice applies during the call. The call marks who is
    speaking, and the connection statistics list its connections.
-   Files in the chat: the attach button shares files of any size. The
    others download a file directly from a browser that has it: the
    sender's, or of someone who downloaded it already, so a file stays
    available while one of them is here. After a reload, the sender chooses
    a file again to share it again. Received files are always saved as
    data, with their names cleaned of characters that disguise them.
-   The menu is available to everyone. It shows the link of the room with a
    copy button, lets viewers set their name too, and lists the participants,
    marking who presents, who is reconnecting, and yourself.
-   The menu shows the connection statistics while it is open: the state, the
    route, the codecs, the resolution, the frame rate,
    the bitrate, the round trip time and the packet loss. The presenter sees
    them per viewer, with the reason when the quality is limited.
-   Someone without a name is shown as a numbered guest, such as "Guest 3",
    numbered by the order of joining and the same on every screen.
-   Viewers see the state of the room: waiting for a presenter, connecting,
    and switching to a new presenter. When the presenter is away, viewers see
    whether they left the page, lost their connection or are resuming, with
    the time left before the seat is freed.
-   The client reconnects to the rendezvous server when the connection drops.
    A presenter who leaves the page, for example with a reload, keeps their
    seat for 30 seconds and can resume from a dialog. A presenter whose
    connection breaks keeps their seat for 5 minutes and resumes
    automatically when it comes back.
-   The rendezvous server sends a "ping" message to its clients every 15
    seconds, so that it notices dead connections, and limits the size of
    incoming messages to 64 KiB.
-   Add test scripts for developers: `pnpm test:protocol` checks the
    signaling protocol against the rendezvous server (and
    `pnpm test:protocol:cloudflare` against the Durable Object), and
    `pnpm test:e2e` checks the website in headless Chrome.

### Changed

-   The interface is rebuilt with React and Mantine, in a dark color scheme:
    a toolbar with icon buttons and tooltips, the chat beside the stage, the
    menu as a drawer from the side, and notices at the bottom. The texts come
    from one dictionary per language instead of a copy of the page per
    language. The stylesheet is now "screensy.css", built with the script.
-   Replace the signaling protocol. The fixed broadcaster and viewer roles are
    gone. The server sends the state of the room to every participant and
    relays WebRTC messages per stream. The protocol is ready for several
    presenters at once, but the server allows one for now.
-   Denying access to the screen now shows a notice that can be closed,
    instead of a full-page message. The person stays in the room as a viewer.
-   The website sends `Cache-Control: no-cache`, so that browsers do not run an
    outdated "screensy.js" against a newer rendezvous server.
-   Update the toolchain: Node.js 26, Go 1.27 and TypeScript 7. The versions
    are pinned with mise in "mise.toml".
-   Manage the JavaScript dependencies with pnpm in a workspace, instead of
    npm.
-   Replace Prettier with Biome for formatting and linting.
-   Update the rendezvous server to ws 8. Node.js now runs its TypeScript code
    directly, so it no longer needs to be compiled.
-   Update `golang.org/x/text` to 0.43.0 and add the missing "go.sum".
-   Update the Docker images to Node.js 26, Go 1.27 and Alpine 3.24. They are
    now built from the root of the repository.
-   Update Caddy to 2.11.7.
-   The rooms of the rendezvous server live in "rooms.ts", which runs both on
    Node.js and in the Durable Object.
-   Use `basic_auth` instead of the deprecated `basicauth` in the Caddyfile.
-   The website container now serves files only from its own directory, instead
    of from the root of the filesystem.
-   The server and the browser client share the protocol as Zod schemas in a
    new workspace package, "screensy-protocol", and validate every message
    they receive with them, including the WebRTC payload of a signal.
-   Split the browser client into modules, bundled with esbuild into a
    minified "screensy.js" with a source map.

### Removed

-   Remove coturn, the STUN and TURN server, from the Docker setup, with
    "turnserver.conf" and its fixed username and password. The browsers use
    Cloudflare's public STUN server instead, and nothing relays the video:
    viewers who find no direct path to the presenter, for example on some
    mobile networks, get no video.
-   Remove the Chinese, Czech, Dutch, French, German, Hebrew and Portuguese
    translations. Screensy is now available in English and Japanese only.

### Fixed

-   The video now reaches viewers more reliably. The client no longer sets
    `iceCandidatePoolSize`. Candidates that Chrome gathered in advance
    sometimes left the connection stuck: the viewer could not reach the
    presenter, and no video arrived.
-   The website now connects to the rendezvous server with `ws://` when it is
    served over plain HTTP. It always used `wss://` before, because it compared
    `location.protocol` with "http" instead of "http:".
-   The rendezvous server now drops messages that are valid JSON but not
    objects, instead of passing them to its type guards.
-   The Docker example Caddyfile in the README now uses the correct port of the
    website container.

## 1.9.0 - 2023-02-07

### Added

-   Add the French translation.

## 1.8.0 - 2022-05-09

### Added

-   Add the Portuguese translation.

## 1.7.1 - 2022-03-28

### Fixed

-   The message shown if the user does not have JavaScript enabled will now be
    styled correctly.

## 1.7.0 - 2021-11-19

### Added

-   Add the Chinese translation.

## 1.6.1 - 2021-11-16

### Added

-   Add license information to the client code. As a result, the
    [LibreJS browser extension] will not block the JavaScript code anymore.

### Fixed

-   Fix compilation failure for TypeScript version 4.4.2.

## 1.6.0 - 2021-10-05

### Added

-   Add the Czech translation.

## 1.5.0 - 2021-10-03

### Added

-   Add the German translation.

## 1.4.0 - 2021-09-17

### Added

-   Add the Japanese translation.

## 1.3.1 - 2021-09-09

### Security

-   In previous versions the rendezvous server would crash whenever it received an
    invalid JSON message. This is now fixed: such messages are now discarded.

## 1.3.0 - 2021-08-05

### Added

-   Add the Hebrew translation.
-   Add a TRANSLATORS file.

## 1.2.0 - 2021-08-02

### Added

-   Add localisation based on the browser settings (through the Accept-Language
    header).
-   Add the Dutch translation.

### Changed

-   In the client, the stream is no longer locked to full-screen on mobile
    devices.
-   In the client, more detailed error messages are shown when something goes
    wrong.

### Fixed

-   Fix compilation failure for TypeScript version greater than 4.3.2.

### Security

-   Update the dependency 'ws' of the rendezvous server. The old version had a
    [vulnerability] that can be misused to significantly slow down a webSocket
    server.

## 1.1.0 - 2021-06-07

### Added

-   Include a STUN+TURN server in the Docker setup.

### Changed

-   The client now assumes that a STUN or TURN server is hosted on the same domain
    as screensy. Previously, the client used an external STUN server, which is an
    unreliable solution. Also, the client did not use a TURN server.

## 1.0.3 - 2021-06-06

### Fixed

-   Add words to the list that the client uses to generate room names. This
    decreases the chance that two broadcasters happen to generate the same room
    name.

## 1.0.2 - 2021-06-03

### Fixed

-   Fix the failing build of the screensy-website Docker image. This happened
    because we did not specify a version of the TypeScript compiler.

## 1.0.1 - 2021-03-18

### Changed

-   Previously, the website client always used WebSocket Secure for a connection
    to the rendezvous server. Now, the client uses WebSocket if the website is
    served via HTTP, and WebSocket Secure if the website is served via HTTPS.

### Added

-   Screensy can now be hosted on a path that is not the root path.

## 1.0.0 - 2021-03-16

### Added

-   Add the website.
-   Add the rendezvous (signaling) server.
-   Add Dockerfiles and a docker-compose file for easy deployment with Docker.
-   Add a README with instructions on setting up screensy.
-   Add this CHANGELOG.

[keep a changelog]: https://keepachangelog.com/en/1.0.0/
[semantic versioning]: https://semver.org/spec/v2.0.0.html
[librejs browser extension]: https://www.gnu.org/software/librejs/
[vulnerability]: https://www.npmjs.com/advisories/1748
