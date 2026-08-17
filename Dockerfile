FROM node:24-alpine
WORKDIR /app
# copy the whole source tree (preserves the module folders); TypeScript runs natively
# via Node's type stripping, no build step. index.ts is the entry (see its header).
COPY src/ ./
VOLUME /data
EXPOSE 8300
CMD ["node", "index.ts"]
