FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SAKURA_AI_GATEWAY_DATA_DIR=/app/data

LABEL org.opencontainers.image.title="Sakura-AI-Gateway" \
      org.opencontainers.image.source="https://github.com/Guyao146/Sakura-AI-Gateway"

WORKDIR /app

COPY package.json README.md LICENSE LICENSING.md ./
COPY src ./src
COPY public ./public
COPY wiki ./wiki

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]