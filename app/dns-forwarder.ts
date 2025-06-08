// dns-forwarder.ts
import dgram from "dgram";
import type { DnsRequest, DnsServer } from "./types.ts";
import { RequestManager } from "./request-manager.ts";
import { DnsRedisClient } from "./redis-client.ts";
import { parseDomainFromQuery, generateRequestHash } from "./dns-utils.ts";
import { DNS_SERVERS } from "./config.ts";

export class DnsForwarder {
  private currentServerIndex = 0;

  constructor(
    private requestManager: RequestManager,
    private redisClient: DnsRedisClient,
    private dnsServer: dgram.Socket
  ) {}

  async forwardUpstream(
    queryBuffer: Buffer,
    clientInfo: DnsRequest,
    serverIndex: number = 0
  ): Promise<void> {
    if (serverIndex >= DNS_SERVERS.length) {
      console.error("❌ All upstream DNS servers failed");
      return;
    }

    const server = DNS_SERVERS[serverIndex];
    const domain = parseDomainFromQuery(queryBuffer);

    const upstreamQueryId = this.requestManager.generateUniqueUpstreamId();
    clientInfo.upstreamQueryId = upstreamQueryId;
    clientInfo.domain = domain;

    const upstreamQuery = Buffer.from(queryBuffer);
    upstreamQuery.writeUInt16BE(upstreamQueryId, 0);

    const requestHash = generateRequestHash(clientInfo, domain);
    clientInfo.requestHash = requestHash;

    this.requestManager.storeRequest(requestHash, clientInfo);

    console.log(`📤 Request ${requestHash.substring(0, 8)} - ${domain} from ${clientInfo.clientIP}:${clientInfo.clientPort}`);

    const upstreamSocket = dgram.createSocket("udp4");

    upstreamSocket.on("message", async (response: Buffer) => {
      await this.handleUpstreamResponse(response, upstreamSocket);
    });

    upstreamSocket.on("error", (err) => {
      console.error(`Failed to contact ${server.name}:`, err);
      this.cleanup(requestHash, upstreamQueryId, upstreamSocket);
      this.forwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
    });

    setTimeout(() => {
      if (this.requestManager.getRequestByHash(requestHash)) {
        console.log(`⏰ Timeout ${requestHash.substring(0, 8)} - ${server.name}, trying next...`);
        this.cleanup(requestHash, upstreamQueryId, upstreamSocket);
        this.forwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
      }
    }, 5000);

    upstreamSocket.send(upstreamQuery, server.port, server.ip, (err) => {
      if (err) {
        console.error(`Failed to contact ${server.name} (${server.ip}):`, err);
        this.cleanup(requestHash, upstreamQueryId, upstreamSocket);
        this.forwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
      } else {
        console.log(`📤 Forwarded ${domain} to ${server.name} (${requestHash.substring(0, 8)})`);
        this.currentServerIndex = serverIndex;
      }
    });
  }

  private async handleUpstreamResponse(response: Buffer, upstreamSocket: dgram.Socket): Promise<void> {
    const responseQueryId = response.readUInt16BE(0);
    const originalRequest = this.requestManager.getRequestByUpstreamId(responseQueryId);
    
    if (originalRequest) {
      console.log(`📥 Response ${originalRequest.requestHash.substring(0, 8)} - ${originalRequest.domain} -> ${originalRequest.clientIP}:${originalRequest.clientPort}`);

      await this.redisClient.cacheResponse(originalRequest.domain, response, 300);

      response.writeUInt16BE(originalRequest.queryId, 0);

      this.dnsServer.send(
        response,
        originalRequest.clientPort,
        originalRequest.clientIP,
        (err) => {
          if (err) console.error("Error sending response to the client", err);
        }
      );

      this.requestManager.removeRequest(originalRequest.requestHash, originalRequest.upstreamQueryId);
      upstreamSocket.close();
    } else {
      console.warn(`⚠️ Received orphaned response with ID: ${responseQueryId}`);
      upstreamSocket.close();
    }
  }

  private cleanup(requestHash: string, upstreamQueryId: number, socket: dgram.Socket): void {
    this.requestManager.removeRequest(requestHash, upstreamQueryId);
    socket.close();
  }
}