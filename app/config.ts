// config.ts
export const config = {
  DNS_PORT: parseInt(process.env.DNS_PORT || "8053"),
  BIND_ADDRESS: process.env.BIND_ADDRESS || "0.0.0.0",
  REDIS_HOST: process.env.REDIS_HOST || "localhost",
  REDIS_PORT: parseInt(process.env.REDIS_PORT || "6379"),
  NODE_ENV: process.env.NODE_ENV || "development"
};

export const DNS_SERVERS = [
  { ip: "8.8.8.8", port: 53, name: "Google Primary" },
  { ip: "1.1.1.1", port: 53, name: "Cloudflare Primary" },
  { ip: "9.9.9.9", port: 53, name: "Quad9 Primary" },
];