FROM node:26-alpine3.24 AS builder

# Node.js 25 and later no longer ship corepack, so install pnpm explicitly
RUN npm install --global pnpm@12.16.1

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY screensy-protocol/ ./screensy-protocol/
COPY screensy-rendezvous/ ./screensy-rendezvous/
COPY screensy-website/package.json ./screensy-website/

# The production dependencies of the server and of the shared protocol. The workspace layout stays, instead of a
# standalone copy (pnpm deploy): Node.js does not strip the types of .ts files under node_modules, and the link to
# screensy-protocol resolves to its directory outside node_modules.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter "screensy-rendezvous..."



FROM node:26-alpine3.24

WORKDIR /home/node/app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/screensy-protocol ./screensy-protocol
COPY --from=builder /app/screensy-rendezvous ./screensy-rendezvous

WORKDIR /home/node/app/screensy-rendezvous

USER node

EXPOSE 4000

# Node.js runs the TypeScript sources directly by stripping the type annotations
CMD ["node", "server.ts"]
