// server.ts
import dgram from "dgram";
import { config } from "./config.ts";
import type { DnsRequest } from "./types.ts";
import { DnsRedisClient } from "./redis-client.ts";
import { RequestManager } from "./request-manager.ts";
import { DnsForwarder } from "./dns-forwarder.ts";
import { parseDomainFromQuery } from "./dns-utils.ts";

class DnsServer {
  private server: dgram.Socket;
  private redisClient: DnsRedisClient;
  private requestManager: RequestManager;
  private forwarder: DnsForwarder;

  constructor() {
    this.server = dgram.createSocket("udp4");
    this.redisClient = new DnsRedisClient();
    this.requestManager = new RequestManager();
    this.forwarder = new DnsForwarder(this.requestManager, this.redisClient, this.server);
  }

  async initialize(): Promise<void> {
    await this.redisClient.initialize();
    this.setupEventHandlers();
    this.startCleanupTimer();
    this.startStatsTimer();
  }

  private setupEventHandlers(): void {
    this.server.on("message", this.handleDnsQuery.bind(this));
    this.server.on("error", this.handleServerError.bind(this));
    
    process.on("SIGINT", this.gracefulShutdown.bind(this));
    process.on("SIGTERM", this.gracefulShutdown.bind(this));
  }

  private async handleDnsQuery(queryBuffer: Buffer, remoteAddr: dgram.RemoteInfo): Promise<void> {
    try {
      const queryId = queryBuffer.readUInt16BE(0);
      const domain = parseDomainFromQuery(queryBuffer);
      
      console.log(`🔍 Query from ${remoteAddr.address}:${remoteAddr.port} - ${domain} (ID: ${queryId})`);

      await this.redisClient.incrementQueryCount();

      const cachedResponse = await this.redisClient.getCachedResponse(domain);
      if (cachedResponse) {
        cachedResponse.writeUInt16BE(queryId, 0);
        
        this.server.send(cachedResponse, remoteAddr.port, remoteAddr.address, (err) => {
          if (err) {
            console.error("Error sending cached response:", err);
          } else {
            console.log(`⚡ Sent cached response for ${domain} to ${remoteAddr.address}:${remoteAddr.port}`);
          }
        });
        return;
      }

      const clientInfo: DnsRequest = {
        clientIP: remoteAddr.address,
        clientPort: remoteAddr.port,
        timestamp: Date.now(),
        queryId: queryId,
        upstreamQueryId: 0,
        domain: "",
        requestHash: ""
      };

      await this.forwarder.forwardUpstream(queryBuffer, clientInfo);
    } catch (error) {
      console.error("Error processing DNS query:", error);
    }
  }

  private handleServerError(error: Error): void {
    console.error("❌ DNS Server error:", error);
  }

  private startCleanupTimer(): void {
    setInterval(() => {
      const cleanedCount = this.requestManager.cleanupStaleRequests();
      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned ${cleanedCount} stale requests`);
      }
    }, 60000);
  }

  private startStatsTimer(): void {
    setInterval(async () => {
      if (this.redisClient.isReady()) {
        try {
          const stats = await this.redisClient.getStats();
          console.log(`📊 Total queries processed: ${stats.queries}`);
        } catch (error) {
          // Ignore stats errors
        }
      }
    }, 300000);
  }

  start(): void {
    this.server.bind(config.DNS_PORT, config.BIND_ADDRESS, () => {
      console.log(`🚀 DNS Server listening on ${config.BIND_ADDRESS}:${config.DNS_PORT}`);
      console.log(`🐳 Docker Mode: ${config.NODE_ENV === "production" ? "Yes" : "No"}`);
      console.log(`📡 Redis: ${config.REDIS_HOST}:${config.REDIS_PORT} (${this.redisClient.isReady() ? "Connected" : "Disconnected"})`);
    });
  }

  private gracefulShutdown(): void {
    console.log("\n🛑 Shutting down DNS server...");
    const stats = this.requestManager.getStats();
    console.log(`📊 Pending requests: ${stats.pending}`);
    console.log(`📊 Upstream mappings: ${stats.upstream}`);
    
    this.server.close(() => {
      console.log("✅ DNS server stopped");
      process.exit(0);
    });
  }
}

// Initialize and start the server
const dnsServer = new DnsServer();
dnsServer.initialize().then(() => {
  dnsServer.start();
});