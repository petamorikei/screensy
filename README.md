# screensy

| Authors                          | Date             |
| -------------------------------- | ---------------- |
| Stef Gijsberts, Marijn van Wezel | March 17th, 2022 |

Screensy is a simple screen sharing solution. Nothing more, nothing less.

This repository is a fork of [screensy/screensy](https://github.com/screensy/screensy).
It adds several presenters at once, a chat, a voice call, reconnection, quality settings and
Cloudflare Workers, among other things; see [CHANGELOG.md](CHANGELOG.md). The
setup below is for this fork.

It consists of two parts, the rendezvous part which runs on the server, and the
website part which runs in the user's browser. The rendezvous server is only
used for protocol negotiation and discovery of the participants. The video
stream is directly sent from the browser of each presenter to the browser of
each viewer, and the chat messages and the call go directly between the browsers too.
All traffic (between rendezvous and browser and between browsers) is encrypted
by default.

## Quick start

Choose who can open screensy:

| Setup                                                                          | Who can open it                       | What you need                       |
| ------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------- |
| [Only inside your tailnet](#inside-your-tailnet-or-with-tailscale-funnel)      | The devices in your Tailscale network | A machine with Docker and Tailscale |
| [Public, with Tailscale Funnel](#inside-your-tailnet-or-with-tailscale-funnel) | Anyone with the link                  | A machine with Docker and Tailscale |
| [Public, on Cloudflare Workers](#on-cloudflare-workers)                        | Anyone with the link                  | A Cloudflare account (free plan)    |

Screensy does not relay the video: when two browsers find no direct path, for
example between some mobile or company networks, the viewer gets no video. See
[STUN servers](#stun-servers).

For a server of your own with a domain, see
[Server Setup (With Docker)](#server-setup-with-docker) and
[Server Setup (Without Docker)](#server-setup-without-docker).

### Inside your tailnet, or with Tailscale Funnel

On a machine with [Docker](https://docs.docker.com/engine/install/) (Docker
Compose 2.24 or later) and [Tailscale](https://tailscale.com/download):

1.  Clone this repository:

    ```sh
    git clone https://github.com/petamorikei/screensy.git
    cd screensy/
    ```

2.  Use the settings for Tailscale, "docker-compose.tailscale.yaml" and
    "Caddyfile.tailscale": Caddy then serves plain HTTP on localhost:80 only,
    and Tailscale provides HTTPS.

    ```sh
    echo "COMPOSE_FILE=docker-compose.yaml:docker-compose.tailscale.yaml" > .env
    ```

3.  _With Funnel_: anyone on the internet can open the page, so protect it
    with a password in "Caddyfile.tailscale"; see
    [password-protect your screensy instance](#optional-password-protect-your-screensy-instance).

4.  Start screensy:

    ```sh
    docker compose up -d
    ```

5.  Share it through Tailscale, with one of these commands (on Linux, with
    `sudo`):

    ```sh
    tailscale serve --bg 80    # only inside your tailnet
    tailscale funnel --bg 80   # public
    ```

    The first time, Tailscale asks you to enable HTTPS certificates (and
    Funnel) for your tailnet, with a link to the admin console.

Screensy is then at `https://<machine name>.<tailnet name>.ts.net/`, which
`tailscale serve status` shows. `tailscale serve reset` stops sharing it, with
everything else that Tailscale serves on this machine.

### On Cloudflare Workers

With [mise](https://mise.jdx.dev/) activated in your shell:

1.  Clone this repository, and install the toolchain and the dependencies:

    ```sh
    git clone https://github.com/petamorikei/screensy.git
    cd screensy/
    mise install
    pnpm install
    ```

2.  Log in to Cloudflare, and deploy:

    ```sh
    pnpm --filter screensy-cloudflare exec wrangler login
    pnpm --filter screensy-cloudflare run cf:deploy
    ```

Screensy is then at the address that Wrangler prints, such as
`https://screensy.<your-subdomain>.workers.dev`. Anyone with the link can open
it; see [Setup on Cloudflare Workers](#setup-on-cloudflare-workers) for how to
restrict it, and for the limits of the free plan.

## Server Setup (With Docker)

1.  Follow this guide to install Docker on your machine:

    https://docs.docker.com/engine/install/

2.  Make sure the Docker Compose plugin is installed. It is included with
    Docker Desktop. On Linux, follow this guide if `docker compose version`
    does not work:

    https://docs.docker.com/compose/install/

3.  Clone this repository and navigate to it, using the following commands:

    ```sh
    git clone https://github.com/petamorikei/screensy.git
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

2.  Clone this repository and navigate to it, using the following commands:

    ```sh
    git clone https://github.com/petamorikei/screensy.git
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
    for this, as it will conflict with the reverse proxy we will set up in step 8.

7.  Start the rendezvous server, using the following command from the root of
    the repository:

    ```sh
    pnpm --filter screensy-rendezvous start
    ```

    This starts a WebSocket server on port 4000. See
    [STUN servers](#stun-servers) for its settings.

8.  Reverse proxy both the static file server and the rendezvous server. We use
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

3.  _Optional_: add settings to "vars" in
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

## Updating

The rooms live in the memory of the rendezvous server, so restarting it or
deploying again ends every room: the browsers reconnect into new rooms, and the
presenters have to start again.

-   **With Docker**: Docker Compose builds the images from the repository, so
    rebuild them after pulling:

    ```sh
    git pull
    docker compose up -d --build
    ```

-   **Without Docker**: pull, install the toolchain and the dependencies again
    (the pinned versions may have changed), rebuild the website, and restart
    both servers:

    ```sh
    git pull
    mise install && pnpm install
    pnpm --filter screensy-website build
    ```

-   **On Cloudflare Workers**: pull, install, and deploy again:

    ```sh
    git pull
    mise install && pnpm install
    pnpm --filter screensy-cloudflare run cf:deploy
    ```

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

    With Docker, run it in the Caddy container instead:
    `docker compose run --rm caddy caddy hash-password`.

    The command will ask you for a password and will then give you a hash. Make
    sure to copy this hash, because you need it in the next step.

3.  Uncomment the following lines in the Caddyfile ("Caddyfile.tailscale" with
    Tailscale), and replace the username and hash.

    ```caddyfile
    basic_auth {
        <username> <hash>
    }
    ```

    So for example, to protect the instance with the username 'alice' and the
    password 'insecure', use:

    ```caddyfile
    basic_auth {
        alice $2a$14$8dJgh7/AgpefTfJAQ8tTLOc1ncWZT1WYqovXWKTfSral/thxTx9YG
    }
    ```

    Caddy reads the Caddyfile when it starts, so restart it after a change. With
    Docker: `docker compose restart caddy`.

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
        alice $2a$14$8dJgh7/AgpefTfJAQ8tTLOc1ncWZT1WYqovXWKTfSral/thxTx9YG
        bob $2a$14$bHdTM45C9EF7Jd.7gsNBIu8tgJSeoXPJeJccG7hXQ.WJa4p65Ac5S
    }
    ```

## STUN servers

WebRTC connects the presenter and each viewer directly. A STUN server tells each
browser its address as the other side sees it, so that browsers behind a router
can find each other. The video never goes through a STUN server. Screensy has
no TURN server to relay the video when no direct path works, for example
between some mobile networks: those viewers get no video.

By default, the browsers use Cloudflare's public STUN server,
`stun:stun.cloudflare.com:3478`, which learns the IP addresses of the
participants. The rendezvous server tells the browsers which servers to use,
from these environment variables (in ".env" with Docker Compose, and in "vars"
of "wrangler.jsonc" on Cloudflare):

| Variable                  | Default                         | Meaning                                                                                                                |
| ------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SCREENSY_STUN_URLS`      | `stun:stun.cloudflare.com:3478` | STUN servers, comma-separated. `{host}` stands for the host name of the page. Set it to nothing to use no STUN server. |
| `SCREENSY_MAX_PRESENTERS` | `4`                             | The number of people that can present at the same time.                                                                |

To use a STUN server of your own instead, for example Coturn with `stun-only`
on the machine that runs screensy, set `SCREENSY_STUN_URLS=stun:{host}`. Run it
on the host network: through Docker's port forwarding, it would see the address
of the forwarder instead of the browser's.

### With Tailscale

In the [quick start with Tailscale](#inside-your-tailnet-or-with-tailscale-funnel),
inside the tailnet and with Funnel alike, Tailscale only carries the page and
the WebSocket connection. The
browsers connect to each other over their public addresses, as with any other
server, and the people in your tailnet need a direct path just like everyone
else.

A STUN server of your own on that machine would change this for the people in
your tailnet: inside the tailnet, `stun:{host}` resolves to the Tailscale
address of the machine, so the browsers learn their Tailscale addresses, and
Tailscale connects them wherever they are. Viewers outside the tailnet cannot
reach it through Funnel, which only forwards TLS over TCP, so keep the public
one for them too (`stun:{host},stun:stun.cloudflare.com:3478`). On macOS, run
that STUN server outside Docker, for example from Homebrew: the host network of
Docker Desktop and OrbStack is a virtual machine that the tailnet does not
reach.

## Bandwidth

The video goes from each presenter to each viewer directly. Each presenter
uploads one stream per participant, and each participant downloads one stream
per presenter: with four presenters, a viewer receives four streams. Lower the
bitrate or the resolution in the menu when the connections are slow.

## Ports

The following ports need to be accessible by the client for screensy to work
on a server of your own (not with Tailscale, which only uses localhost:80, and
not on Cloudflare):

| Port number | Protocol | Service |
| ----------- | -------- | ------- |
| 80          | TCP      | HTTP    |
| 443         | TCP      | HTTPS   |
