# Container chạy test database. Không bao giờ deploy.
#
# node_modules nằm trong image tại /work/node_modules; compose bind-mount đè
# `test/` và `migrations/` để sửa file là chạy lại được ngay, không cần rebuild.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

CMD ["sleep", "infinity"]
