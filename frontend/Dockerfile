FROM node:22.16.0-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY public ./public
COPY src ./src

ARG REACT_APP_MAPBOX_ACCESS_TOKEN
ARG REACT_APP_MAPBOX_STYLE_URL
ENV REACT_APP_MAPBOX_ACCESS_TOKEN=${REACT_APP_MAPBOX_ACCESS_TOKEN} \
    REACT_APP_MAPBOX_STYLE_URL=${REACT_APP_MAPBOX_STYLE_URL} \
    GENERATE_SOURCEMAP=false
RUN npm run build

FROM nginx:1.28-alpine AS production

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/readyz || exit 1
