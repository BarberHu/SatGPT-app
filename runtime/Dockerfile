FROM node:22.16.0-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json server.ts ./
RUN npm run build

FROM node:22.16.0-slim AS production

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system satgpt && useradd --system --gid satgpt satgpt
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=satgpt:satgpt /app/dist ./dist

USER satgpt
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:5000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
