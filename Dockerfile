# Dockerfile 
FROM oven/bun:latest
WORKDIR /app

COPY . .

RUN bun install

EXPOSE 8053/udp

ENV NODE_ENV=production
ENV REDIS_HOST=redis
ENV REDIS_PORT=6379
ENV REDIS_URL=redis://redis:6379

CMD ["bun", "app/server.ts"]


