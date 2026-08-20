# Microsoft's official Playwright image bundles Node, Chromium,
# all required system libs, and ffmpeg. Using it as both builder and
# runner avoids native-binary (glibc/musl) mismatches between stages.
FROM mcr.microsoft.com/playwright:v1.60.0-noble AS builder
WORKDIR /app
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY . .
RUN npm run build:tracker
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Bind Next.js's standalone server to all interfaces. Without this it
# sometimes binds to the container's own hostname which Railway's
# external healthcheck can't reach.
ENV HOSTNAME=0.0.0.0

# Playwright's image bundles a private ffmpeg for its internal video
# encoder but doesn't expose it on PATH. We use ffmpeg ourselves to
# transcode the recorded webm to mp4 with libx264, so install the
# system package. Chromium also goes here — Playwright's bundled one
# works too but the apt path is simpler.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/* || true

# Fall back to Playwright's bundled Chromium if the apt one isn't there
# for any reason; playwright-core resolves the right one at launch.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/lib/db/migrations ./lib/db/migrations
COPY --from=builder /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=builder /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/node_modules/postgres ./node_modules/postgres
# playwright-core is marked as external in next.config.ts so it's
# required from node_modules at runtime (its browsers.json + native
# bindings can't be statically traced by Next's output tracer).
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
# rrweb-player's umd bundle + css are read at module-init by the /video
# route and inlined into the page playwright loads. (jsdelivr serves
# the .cjs file with content-type application/node which browsers
# refuse to execute as JS, so we can't just <script src=cdn>.)
COPY --from=builder /app/node_modules/rrweb-player ./node_modules/rrweb-player
# @huggingface/transformers (visitor-segment embeddings) is external for
# the same reason as playwright-core: onnxruntime-node's libonnxruntime.so
# and sharp's platform binaries aren't statically traceable, so copy the
# full packages including native libs.
COPY --from=builder /app/node_modules/@huggingface ./node_modules/@huggingface
COPY --from=builder /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=builder /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=builder /app/node_modules/onnxruntime-web ./node_modules/onnxruntime-web
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img

CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]

EXPOSE 3000
