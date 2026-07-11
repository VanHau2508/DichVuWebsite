# Build context là REPO ROOT (xem compose: context: .., dockerfile: apps/auth/Dockerfile)
# vì server.js import mã dùng chung từ packages/auth/src qua đường dẫn tương đối.
# Layout /app/{apps,packages} được giữ nguyên để đường dẫn ../../../packages/... khớp,
# và node_modules ở /app để cả hai cây import giải được dependency.

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /app

COPY apps/auth/package.json apps/auth/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY packages/auth/src ./packages/auth/src
COPY apps/auth/src     ./apps/auth/src

USER node
ENV NODE_ENV=production PORT=3020
EXPOSE 3020

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3020)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/auth/src/server.js"]
