# screensy

| Authors                          | Date             |
| -------------------------------- | ---------------- |
| Stef Gijsberts, Marijn van Wezel | March 17th, 2022 |

Screensy is a simple screen sharing solution. Nothing more, nothing less.

It consists of two parts, the rendezvous part which runs on the server, and the
website part which runs in the user's browser. The rendezvous server is only
used for protocol negotiation and discovery of viewers. The video stream is
directly sent from the browser of the broadcaster to the browser of each viewer.
All traffic (between rendezvous and browser and between browsers) is encrypted
by default.

There are three ways to set up screensy: with Docker, without Docker, or on
Cloudflare Workers. If you don't know which one to choose, we recommend using
Docker on a server of your own, or Cloudflare Workers if you have no server.

Screensy does not relay the video: when two browsers find no direct path, for
example between some mobile or company networks, the viewer gets no video. See
[STUN servers](#stun-servers).

## Server Setup (With Docker)

1.  Follow this guide to install Docker on your machine:

    https://docs.docker.com/engine/install/

2.  Make sure the Docker Compose plugin is installed. It is included with
    Docker Desktop. On Linux, follow this guide if `docker compose version`
    does not work:

    https://docs.docker.com/compose/install/

3.  Clone this repository and navigate to it, using the following commands:

    ```sh
    git clone https://github.com/screensy/screensy.git
    cd screensy/
    ```

4.  Change the first line of the included Caddyfile to your domain. For example
    if you want to host screensy on the domain "example.com", use this
    Caddyfile:

    ```caddyfile
    example.com {
        reverse_proxy website:8080

        @rendezvous {
            header Connection *Upgrade*
            header Upgrade websocket
        }

        reverse_proxy @rendezvous rendezvous:4000
    }
    ```

5.  _Optional_: password-protect your screensy instance using the method
    described at the bottom of this document.

6.  _Optional_: create the file ".env" from ".env.example" to change the
    STUN servers or the number of people that can present at the same time;
    see [STUN servers](#stun-servers).

7.  Make sure the required ports are accessible. We listed these ports at the
    bottom of this document.

8.  Start the Docker containers using Docker Compose, by running the following
    command:

    ```sh
    docker compose up -d
    ```

## Server Setup (Without Docker)

1.  Make sure you have the following software installed on your server:
    -   [mise](https://mise.jdx.dev/), which installs the pinned versions of
        Node.js, pnpm and Go listed in "mise.toml"
    -   A reverse proxy that supports WebSocket (we recommend Caddy)
    -   A STUN server (we recommend Coturn)

2.  Clone this repository and navigate to it, using the following commands:

    ```sh
    git clone https://github.com/screensy/screensy.git
    cd screensy/
    ```

3.  Install Node.js, pnpm and Go, and then the JavaScript dependencies, using
    the following commands:

    ```sh
    mise install
    pnpm install
    ```

4.  Compile the TypeScript code of the website, using the following command:

    ```sh
    pnpm --filter screensy-website build
    ```

    The rendezvous server does not need to be compiled, because Node.js runs
    its TypeScript code directly.

5.  Make sure the required ports are accessible. We listed these ports at the
    bottom of this document.

6.  Start the webserver using the following command:

    ```sh
    cd screensy-website && go run .
    ```

    This starts the webserver on port 8080. We do not use the standard port "80"
    for this, as it will conflict with the reverse proxy we will set up in step 9.

7.  Set up the STUN server. We use Coturn with the following "turnserver.conf"
    for this:

    ```ini
    listening-port=3478
    stun-only
    no-tls
    ```

8.  Start the rendezvous server, using the following command from the root of
    the repository:

    ```sh
    pnpm --filter screensy-rendezvous start
    ```

    This starts a WebSocket server on port 4000. See
    [STUN servers](#stun-servers) for its settings.

9.  Reverse proxy both the static file server and the rendezvous server. We use
    the following Caddyfile for this:

    ```caddyfile
    example.com {
        reverse_proxy localhost:8080

        @rendezvous {
            header Connection *Upgrade*
            header Upgrade websocket
        }

        reverse_proxy @rendezvous localhost:4000
    }
    ```

    Keep in mind that most web browsers require HTTPS for WebRTC to work.

## Setup on Cloudflare Workers

The "screensy-cloudflare" package runs screensy on Cloudflare: a Worker serves
the page, and a Durable Object runs the rendezvous server. It fits in the free
Workers plan, and Cloudflare provides the HTTPS address (`*.workers.dev`) and a
public STUN server.

1.  Clone this repository, and install the toolchain and the dependencies, as in
    steps 2 and 3 of [Server Setup (Without Docker)](#server-setup-without-docker).

2.  Log in to Cloudflare with Wrangler:

    ```sh
    pnpm --filter screensy-cloudflare exec wrangler login
    ```

3.  _Optional_: change the settings in "vars" of
    "screensy-cloudflare/wrangler.jsonc" (see [STUN servers](#stun-servers)).

4.  Build and deploy:

    ```sh
    pnpm --filter screensy-cloudflare run cf:deploy
    ```

    Wrangler prints the address, such as
    `https://screensy.<your-subdomain>.workers.dev`.

`pnpm --filter screensy-cloudflare dev` runs the same Worker on your machine, at
http://localhost:8787.

Things to know:

-   The free plan allows 100,000 requests to the Durable Object a day, and every
    message that a browser sends counts. A browser answers the server's ping
    every 15 seconds (240 times an hour), and setting up a connection takes a
    few dozen messages more. Over the limit, connections fail until 00:00 UTC.
-   All the rooms live in the memory of one Durable Object, which stays running
    while anyone is connected. Deploying, or Cloudflare restarting it, ends every
    room: the browsers reconnect into new rooms, and the presenters have to
    start again. While nobody is connected, Cloudflare may also stop it: a
    presenter who reloads the page alone in a room may not get their seat back.
-   There is no Caddy, so the Basic Authentication below does not apply. Put
    [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
    in front of the Worker to restrict who can open it.

## Optional: password-protect your screensy instance

To password-protect your screensy instance, you can set up HTTP Basic
Authentication. We recommend it for any instance that is reachable from the
internet:

-   Anyone who knows the address of your instance can otherwise create rooms
    on it and look for rooms in use. Room names are four random words, about
    two million combinations, which is not enough to keep a determined person
    out.
-   Screensy has no passwords for single rooms. Basic Authentication protects
    the whole instance instead: the page, and the WebSocket connection to the
    rendezvous server. Browsers ask for the username and password once, and
    then send them on the WebSocket connection too.

1.  Choose a username and password.

2.  Calculate a hash for your password using the following command:

    ```sh
    caddy hash-password
    ```

    The command will ask you for a password and will then give you a hash. Make
    sure to copy this hash, because you need it in the next step.

3.  Uncomment the following lines in the Caddyfile, and replace the username and
    hash.

    ```caddyfile
    basic_auth {
        <username> <hash>
    }
    ```

    So for example, to protect the instance with the username 'alice' and the
    password 'insecure', use:

    ```caddyfile
    basic_auth {
        alice JDJhJDE0JDhkSmdoNy9BZ3BlZlRmSkFROHRUTE9jMW5jV1pUMVdZcW92WFdLVGZTcmFsL3RoeFR4OVlH
    }
    ```

4.  _Optional, more advanced_: You can add more username-hash pairs, or
    exclude certain IP adresses from needing authentication. For example, the
    following lines protect the instance with the username 'alice' and the
    password 'insecure', and the username 'bob' and the password 'unsafe', and
    exclude local IP addresses from needing authentication:

    ```caddyfile
    @needauth {
        # Non-local IPs need authentication
        not remote_ip 192.168.0.0/16 172.16.0.0/12 10.0.0.0/8
    }

    basic_auth @needauth {
        alice JDJhJDE0JDhkSmdoNy9BZ3BlZlRmSkFROHRUTE9jMW5jV1pUMVdZcW92WFdLVGZTcmFsL3RoeFR4OVlH
        bob JDJhJDE0JGJIZFRNNDVDOUVGN0pkLjdnc05CSXU4dGdKU2VvWFBKZUpjY0c3aFhRLldKYTRwNjVBYzVT
    }
    ```

## STUN servers

WebRTC connects the presenter and each viewer directly. A STUN server tells each
browser its address as the other side sees it, so that browsers behind a router
can find each other. Screensy has no TURN server to relay the video when no
direct path works, for example between some mobile networks: those viewers get
no video. The video never goes through a STUN server.

The rendezvous server tells the browsers which servers to use, from these
environment variables (in ".env" with Docker Compose, and in "vars" of
"wrangler.jsonc" on Cloudflare):

| Variable                  | Default       | Meaning                                                                                                        |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `SCREENSY_STUN_URLS`      | `stun:{host}` | STUN servers, comma-separated. `{host}` is the host name of the page. Set it to nothing to use no STUN server. |
| `SCREENSY_MAX_PRESENTERS` | `4`           | The number of people that can present at the same time.                                                        |

On Cloudflare, the default is Cloudflare's STUN server,
`stun:stun.cloudflare.com:3478`. A public STUN server like this one works where
you cannot run your own, but it learns the IP addresses of the participants.

Docker Compose runs Coturn as the STUN server (the "stun" service) on the host
network: through Docker's port forwarding, it would see the address of the
forwarder instead of the browser's.

### At home, with Tailscale

When screensy runs on a machine at home, Tailscale offers two ways to reach it.
For both, change the first line of the Caddyfile to `:80`, so that Caddy serves
plain HTTP and Tailscale provides HTTPS.

-   **Only inside your tailnet**: run `tailscale serve --bg 80`, and keep the
    default `stun:{host}`. Inside the tailnet, the name of the page resolves to
    the Tailscale address of the machine, so the browsers learn their Tailscale
    addresses from the STUN server, and Tailscale connects them wherever they
    are.

-   **Public, with Tailscale Funnel**: run `tailscale funnel --bg 80`. Funnel
    only forwards TLS connections over TCP, so viewers outside your tailnet
    cannot reach your STUN server. Add a public one for them, in ".env":

    ```sh
    SCREENSY_STUN_URLS=stun:{host},stun:stun.cloudflare.com:3478
    ```

    The people in your tailnet still use yours.

On macOS, the host network of Docker (Docker Desktop, OrbStack) is a virtual
machine that the tailnet does not reach. Run Coturn from Homebrew instead, with
the "turnserver.conf" of
[Server Setup (Without Docker)](#server-setup-without-docker) in
`$(brew --prefix)/etc/turnserver.conf`:

```sh
brew install coturn
brew services start coturn
```

and leave the "stun" service out with a "docker-compose.override.yaml":

```yaml
services:
  stun:
    profiles: ["stun"]
```

## Bandwidth

The video goes from each presenter to each viewer directly. Each presenter
uploads one stream per participant, and each participant downloads one stream
per presenter: with four presenters, a viewer receives four streams. Lower the
bitrate or the resolution in the menu when the connections are slow.

## Ports

The following ports need to be accessible by the client for screensy to work
(not on Cloudflare):

| Port number | Protocol | Service |
| ----------- | -------- | ------- |
| 80          | TCP      | HTTP    |
| 443         | TCP      | HTTPS   |
| 3478        | TCP/UDP  | STUN    |
