FROM node:24-bookworm-slim
WORKDIR /app/services
COPY services/package.json services/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/shared ./shared
COPY services/academic/src ./academic/src
EXPOSE 3102
USER node
CMD ["node", "academic/src/index.js"]
