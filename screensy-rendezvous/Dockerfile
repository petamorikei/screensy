FROM node:26-alpine3.24 AS builder

# Node.js 25 and later no longer ship corepack, so install pnpm explicitly
RUN npm install --global pnpm@12.16.1

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY screensy-website/package.json ./screensy-website/
COPY screensy-rendezvous/ ./screensy-rendezvous/

# Create a standalone copy of the package with only its production dependencies
RUN pnpm --filter screensy-rendezvous deploy --prod --frozen-lockfile --ignore-scripts /out



FROM node:26-alpine3.24

WORKDIR /home/node/app

COPY --from=builder /out/package.json /out/server.ts ./
COPY --from=builder /out/node_modules ./node_modules

USER node

EXPOSE 4000

# Node.js runs the TypeScript source directly by stripping the type annotations
CMD ["node", "server.ts"]
