# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
# `pnpm-workspace.yaml` rides along with the manifest and the lockfile (DW-431).
# The build stage's `COPY . .` supplies it — `.dockerignore` does not exclude it
# — so without it here the two stages disagree about whether `/app` is a pnpm
# workspace root: this stage would have pnpm walk UP out of `/app` looking for
# one, while the build stage resolves it in place. Both stages must see the same
# root, and `src/lib/__tests__/pnpm-workspace-root.test.ts` pins that they do.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Stage 2: Build the application
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Stage 3: Production runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy application files (standard Next.js output — no standalone mode)
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./

# Create data directories and set ownership
RUN mkdir -p /app/wiki /app/raw && \
    chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3000

CMD ["npx", "next", "start"]
