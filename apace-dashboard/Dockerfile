FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so a code change does not reinstall them.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
# Included so `docker compose up demo` can run the synthetic market with no keys.
COPY test ./test

# Writable location for the analysis cache and trade log.
RUN mkdir -p /app/data && chown -R node:node /app
ENV DATA_DIR=/app/data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
