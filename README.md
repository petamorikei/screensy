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

There are two ways to set up screensy. If you don't know which one to choose, we
recommend using Docker.

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

6.  Change the value of the "external-ip" setting in the included
    "turnserver.conf" from "localhost" to your domain. For example if you want
    to host screensy on the domain "example.com", the first two lines of your
    "turnserver.conf" should look like this:

    ```ini
    # Set the value below to your public IP address or domain.
    external-ip=example.com
    ```

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
    -   A TURN server (again, we recommend Coturn)

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

7.  Set up the STUN and TURN server. Use the long-term credential mechanism
    with the username "screensy" and the password "screensy". We use the
    following "turnserver.conf" for this:

    ```ini
    external-ip=example.com
    listening-port=3478
    user=screensy:screensy
    lt-cred-mech
    realm=screensy
    ```

8.  Start the rendezvous server, using the following command from the root of
    the repository:

    ```sh
    pnpm --filter screensy-rendezvous start
    ```

    This starts a WebSocket server on port 4000.

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
-   It does not protect the TURN server. Its username and password
    ("screensy") are part of the website's code, so anyone can find them and
    relay traffic through your TURN server.

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

## Bandwidth

The video goes from each presenter to each viewer directly. Each presenter
uploads one stream per participant, and each participant downloads one stream
per presenter: with four presenters, a viewer receives four streams. Lower the
bitrate or the resolution in the menu when the connections are slow.

## Ports

The following ports need to be accessible by the client for screensy to work:

| Port number | Protocol | Service   |
| ----------- | -------- | --------- |
| 80          | TCP      | HTTP      |
| 443         | TCP      | HTTPS     |
| 3478        | TCP/UDP  | STUN/TURN |
| 49152-65535 | UDP      | TURN      |
