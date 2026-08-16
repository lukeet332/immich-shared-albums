FROM node:22-alpine
WORKDIR /app
COPY src/index.mjs .
COPY src/web/banner/banner.js .
VOLUME /data
EXPOSE 8300
CMD ["node", "index.mjs"]
