FROM node:24-bookworm-slim
WORKDIR /app/services
COPY services/package.json services/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/shared ./shared
COPY services/identity/src ./identity/src
COPY services/identity/scripts ./scripts
COPY services/migrate-legacy.js ./migrate-legacy.js
EXPOSE 3101
CMD ["node", "identity/src/index.js"]
