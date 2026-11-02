FROM node:22.16.0-slim AS build

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/index.html frontend/vite.config.mjs frontend/projectEnv.cjs frontend/tailwind.config.cjs frontend/postcss.config.cjs ./
COPY frontend/public ./public
COPY frontend/src ./src

ARG REACT_APP_MAPBOX_ACCESS_TOKEN
ARG REACT_APP_MAPBOX_STYLE_URL
ENV REACT_APP_MAPBOX_ACCESS_TOKEN=${REACT_APP_MAPBOX_ACCESS_TOKEN} \
    REACT_APP_MAPBOX_STYLE_URL=${REACT_APP_MAPBOX_STYLE_URL} \
    GENERATE_SOURCEMAP=false
RUN npm run build

FROM node:22.16.0-slim AS production

WORKDIR /app/frontend
COPY --chown=node:node frontend/server.cjs frontend/projectEnv.cjs ./
COPY --from=build --chown=node:node /app/build ./build
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.FRONTEND_PORT||3000)+'/readyz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.cjs"]
