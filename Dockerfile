FROM node:22-bookworm-slim AS build
# Bouwgereedschap voor native modules (better-sqlite3, sharp) als er geen kant-en-klare binary is.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
# Android-app voor de eerste installatie vanaf je eigen cloud (door de CI gevuld; leeg = geen download)
COPY app-dist ./app-dist
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000 2525 7946
CMD ["node", "dist/main.js"]
