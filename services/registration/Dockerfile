FROM node:24-bookworm-slim
WORKDIR /app/services
COPY services/package.json services/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/shared ./shared
COPY services/registration/src ./registration/src
EXPOSE 3103
CMD ["node", "registration/src/index.js"]
