# Image DB: chạy migration runner (service `migrate`) + bộ test (service `dbtest`).
#
# DEV bind-mount đè `test/` và `migrations/` để sửa là chạy lại ngay, không rebuild.
# PROD KHÔNG mount → migrate.js + migrations phải NẰM SẴN trong image (COPY dưới đây),
# nếu không `migrate up` ở production sẽ không có migration nào để chạy.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Bake để prod (không mount) vẫn chạy migration được. Dev mount đè bằng cùng nội dung.
COPY migrate.js ./migrate.js
COPY migrations ./migrations

CMD ["sleep", "infinity"]
