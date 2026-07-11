FROM node:22-alpine

WORKDIR /app

# TODO(trước production): commit package-lock.json và đổi sang `npm ci`.
# `npm install` cho phép phiên bản trôi giữa các lần build — không chấp nhận được
# cho một image chạy production.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Không chạy bằng root.
USER node

ENV NODE_ENV=production PORT=3010
EXPOSE 3010

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
