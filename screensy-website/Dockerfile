FROM node:26-alpine3.24 AS typescript_builder

# Node.js 25 and later no longer ship corepack, so install pnpm explicitly
RUN npm install --global pnpm@12.16.1

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY screensy-protocol/ ./screensy-protocol/
COPY screensy-rendezvous/package.json ./screensy-rendezvous/
COPY screensy-website/package.json screensy-website/tsconfig.json screensy-website/build.mjs ./screensy-website/
COPY screensy-website/src/ ./screensy-website/src/

# The website and the packages it depends on (the shared protocol). esbuild runs from its platform package, without
# install scripts.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "screensy-website..."
RUN pnpm --filter screensy-website build



FROM golang:1.27-alpine3.24 AS go_builder

WORKDIR /go/src/app

COPY screensy-website/go.mod screensy-website/go.sum ./

# Install the dependencies for the project
RUN go mod download

COPY screensy-website/main.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -o screensy-website .



FROM alpine:3.24

# The webserver serves files from its working directory
WORKDIR /app

# The source map carries the sources of the bundle
COPY --from=typescript_builder /app/screensy-website/screensy.js ./
COPY --from=typescript_builder /app/screensy-website/screensy.js.map ./

COPY --from=go_builder /go/src/app/screensy-website ./

COPY screensy-website/translations/ ./translations

COPY screensy-website/styles.css ./

EXPOSE 8080

CMD ["./screensy-website"]
