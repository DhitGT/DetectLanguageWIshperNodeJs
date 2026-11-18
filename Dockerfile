FROM node:22-bookworm-slim
ENV NODE_ENV=production ONNXRUNTIME_NODE_INSTALL_CUDA=skip
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src
RUN mkdir /models && chown node:node /models
USER node
ENV HOST=0.0.0.0 PORT=8000 MODEL_CACHE=/models
EXPOSE 8000
CMD ["node", "src/server.js"]
