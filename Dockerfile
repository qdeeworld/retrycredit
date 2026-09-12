FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.mjs ./
COPY scripts/cloudflare-headers.mjs scripts/verify-web-build-origin.mjs ./scripts/
COPY web ./web
COPY src/recovery-pair-report.mjs ./src/recovery-pair-report.mjs
COPY src/recovery-helper-consent.mjs ./src/recovery-helper-consent.mjs
RUN npm run build:web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
USER node
EXPOSE 4179
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4179)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
