FROM node:26-alpine3.24 AS typescript_builder

# Node.js 25 and later no longer ship corepack, so install pnpm explicitly
RUN npm install --global pnpm@12.16.1

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY screensy-rendezvous/package.json ./screensy-rendezvous/
COPY screensy-website/package.json screensy-website/tsconfig.json screensy-website/screensy.ts ./screensy-website/

RUN pnpm install --frozen-lockfile --ignore-scripts --filter screensy-website
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

COPY --from=typescript_builder /app/screensy-website/screensy.js ./
COPY --from=typescript_builder /app/screensy-website/screensy.js.map ./
COPY --from=typescript_builder /app/screensy-website/screensy.ts ./

COPY --from=go_builder /go/src/app/screensy-website ./

COPY screensy-website/translations/ ./translations

COPY screensy-website/styles.css ./

EXPOSE 8080

CMD ["./screensy-website"]
