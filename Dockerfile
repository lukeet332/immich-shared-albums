FROM node:24-alpine
WORKDIR /app
COPY src/index.ts src/store.ts src/types.ts ./
COPY src/web/banner/banner.js .
VOLUME /data
EXPOSE 8300
CMD ["node", "index.ts"]
