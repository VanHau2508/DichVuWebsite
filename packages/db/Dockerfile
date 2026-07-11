# Container chạy test database. Không bao giờ deploy.
#
# node_modules nằm trong image tại /work/node_modules; compose bind-mount đè
# `test/` và `migrations/` để sửa file là chạy lại được ngay, không cần rebuild.
FROM node:22-alpine

WORKDIR /work
COPY package.json ./
RUN npm install --no-audit --no-fund

CMD ["sleep", "infinity"]
