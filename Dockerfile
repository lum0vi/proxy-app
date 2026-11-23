ARG NODE_IMAGE=node:24.22.3-bookworm-slim
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @proxi/api --include-workspace-root \
    && mkdir -p apps/api/node_modules

FROM ${NODE_IMAGE} AS api
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodeapp && useradd --system --uid 1001 --gid nodeapp nodeapp
COPY --from=production-deps --chown=nodeapp:nodeapp /app/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodeapp /app/package.json ./package.json
COPY --from=build --chown=nodeapp:nodeapp /app/apps/api/package.json ./apps/api/package.json
COPY --from=production-deps --chown=nodeapp:nodeapp /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=nodeapp:nodeapp /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=nodeapp:nodeapp /app/apps/api/migrations ./apps/api/migrations
USER nodeapp
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]

FROM nginx:1.30.6-alpine AS gateway
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
