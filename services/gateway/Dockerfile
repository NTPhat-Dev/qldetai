FROM node:24-bookworm-slim
WORKDIR /app/services
COPY services/package.json services/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/shared ./shared
COPY services/gateway/src ./gateway/src
EXPOSE 3100
USER node
CMD ["node", "gateway/src/index.js"]
