# Dockerfile 
FROM oven/bun:latest
WORKDIR /app

COPY . .

RUN bun install

EXPOSE 8053/udp

CMD ["bun", "app/server.ts"]


