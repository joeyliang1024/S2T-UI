FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG NPM_REGISTRY
COPY package.json package-lock.json ./
COPY dependencies/npm ./dependencies/npm
RUN test -n "$NPM_REGISTRY" && npm ci --ignore-scripts --no-audit --no-fund --registry="$NPM_REGISTRY" --replace-registry-host=npmjs
COPY config ./config
COPY tsconfig.json ./tsconfig.json
COPY frontend ./frontend
COPY backend/resources ./backend/resources
COPY icon ./icon
RUN npm run build:web

FROM nginx:stable-alpine
COPY deploy/web/nginx.conf /etc/nginx/nginx.conf
COPY deploy/web/18-upstream.envsh /docker-entrypoint.d/18-upstream.envsh
RUN chmod +x /docker-entrypoint.d/18-upstream.envsh
COPY deploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/out/web /usr/share/nginx/html
COPY LICENSE /usr/share/nginx/html/LICENSE
ENV FRONTEND_PORT=5173 BACKEND_UPSTREAM=http://backend:8787 DNS_RESOLVER=127.0.0.11
EXPOSE 5173
