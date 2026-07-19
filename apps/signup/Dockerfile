# Build context là REPO ROOT (compose: context: .., dockerfile: apps/signup/Dockerfile)
# vì server.js import mã dùng chung packages/auth/src qua đường dẫn tương đối (mẫu apps/account).
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /app

COPY apps/signup/package.json apps/signup/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY packages/auth/src ./packages/auth/src
COPY apps/signup/src   ./apps/signup/src

USER node
ENV NODE_ENV=production PORT=3064
EXPOSE 3064

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3064)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/signup/src/server.js"]
