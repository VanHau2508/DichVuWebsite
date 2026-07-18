# Build context là REPO ROOT (compose: context: .., dockerfile: apps/account/Dockerfile)
# vì server.js import mã dùng chung packages/auth/src qua đường dẫn tương đối. Mẫu apps/auth.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /app

COPY apps/account/package.json apps/account/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY packages/auth/src ./packages/auth/src
COPY apps/account/src   ./apps/account/src

USER node
ENV NODE_ENV=production PORT=3062
EXPOSE 3062

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3062)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/account/src/server.js"]
