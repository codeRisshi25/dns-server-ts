import dgram from "dgram";
import crypto from "crypto";

// Configuration from environment variables
const config = {
  DNS_PORT: parseInt(process.env.DNS_PORT || "8053"),
  BIND_ADDRESS: process.env.BIND_ADDRESS || "0.0.0.0", // Changed for Docker
  REDIS_HOST: process.env.REDIS_HOST || "localhost",
  REDIS_PORT: parseInt(process.env.REDIS_PORT || "6379"),
  NODE_ENV: process.env.NODE_ENV || "development"
};

// datastructure for dns requests from clients
interface dnsRequest {
  clientIP: string;
  clientPort: number;
  timestamp: number;
  queryId: number;
  upstreamQueryId: number;
  domain: string;
  requestHash: string;
}

// hold the dnsRequest pairs with dual mapping for fast lookup
let pendingRequests = new Map<string, dnsRequest>();
let upstreamToHashMap = new Map<number, string>(); // upstream ID -> request hash
let requestCounter = 0;

// --- Configuration ---
// DNS server pool
const DNS_SERVERS = [
  { ip: "8.8.8.8", port: 53, name: "Google Primary" },
  { ip: "1.1.1.1", port: 53, name: "Cloudflare Primary" },
  { ip: "9.9.9.9", port: 53, name: "Quad9 Primary" },
];

let currentServerIndex = 0;

// create the dns server (bind to all interfaces in Docker)
const dnsServer: dgram.Socket = dgram.createSocket("udp4");
dnsServer.bind(config.DNS_PORT, config.BIND_ADDRESS, () => {
  console.log(`🚀 DNS Server listening on ${config.BIND_ADDRESS}:${config.DNS_PORT}`);
  console.log(`🐳 Docker Mode: ${config.NODE_ENV === "production" ? "Yes" : "No"}`);
  console.log(`📡 Redis: ${config.REDIS_HOST}:${config.REDIS_PORT}`);
});

// Parse domain from DNS query
function parseDomainFromQuery(queryBuffer: Buffer): string {
  let offset = 12;
  let domain = '';
  
  while (offset < queryBuffer.length && queryBuffer[offset] !== 0) {
    const labelLength = queryBuffer[offset];
    offset++;
    
    if (domain.length > 0) domain += '.';
    domain += queryBuffer.toString('ascii', offset, offset + labelLength);
    offset += labelLength;
  }
  
  return domain.toLowerCase();
}

// Generate collision-resistant request hash
function generateRequestHash(clientInfo: dnsRequest, domain: string): string {
  const timestamp = Date.now();
  const counter = ++requestCounter;
  const random = crypto.randomBytes(4).toString('hex');
  const requestKey = `${clientInfo.clientIP}:${clientInfo.clientPort}:${clientInfo.queryId}:${domain}:${timestamp}:${counter}:${random}`;
  
  return crypto
    .createHash("sha256")
    .update(requestKey)
    .digest("hex")
    .substring(0, 16);
}

const dnsForwardUpstream = (
  queryBuffer: Buffer,
  clientInfo: dnsRequest,
  serverIndex: number = 0
) => {
  if (serverIndex >= DNS_SERVERS.length) {
    console.error("❌ All upstream DNS servers failed");
    return;
  }

  const server = DNS_SERVERS[serverIndex];
  const domain = parseDomainFromQuery(queryBuffer);

  // Generate unique queryID for upstream (ensure no collision)
  let upstreamQueryId: number;
  do {
    upstreamQueryId = Math.floor(Math.random() * 65535);
  } while (upstreamToHashMap.has(upstreamQueryId));

  clientInfo.upstreamQueryId = upstreamQueryId;
  clientInfo.domain = domain;

  // Create modified query for upstream
  const upstreamQuery = Buffer.from(queryBuffer);
  upstreamQuery.writeUInt16BE(upstreamQueryId, 0);

  // Generate collision-resistant hash
  const requestHash = generateRequestHash(clientInfo, domain);
  clientInfo.requestHash = requestHash;

  // Store request with both mappings for fast lookup
  pendingRequests.set(requestHash, clientInfo);
  upstreamToHashMap.set(upstreamQueryId, requestHash);

  console.log(`📤 Request ${requestHash.substring(0, 8)} - ${domain} from ${clientInfo.clientIP}:${clientInfo.clientPort}`);

  const upstreamSocket: dgram.Socket = dgram.createSocket("udp4");

  // Handle responses from the upstream server
  upstreamSocket.on("message", (response: Buffer) => {
    const responseQueryId = response.readUInt16BE(0);

    // Fast lookup using upstream query ID
    const matchingHash = upstreamToHashMap.get(responseQueryId);
    
    if (matchingHash && pendingRequests.has(matchingHash)) {
      const originalRequest = pendingRequests.get(matchingHash)!;
      
      console.log(`📥 Response ${matchingHash.substring(0, 8)} - ${originalRequest.domain} -> ${originalRequest.clientIP}:${originalRequest.clientPort}`);

      //! IMP Restore original client query ID before sending response back
      response.writeUInt16BE(originalRequest.queryId, 0);

      // Send response back to the original client
      dnsServer.send(
        response,
        originalRequest.clientPort,
        originalRequest.clientIP,
        (err) => {
          if (err) console.error("Error sending response to the client", err);
        }
      );

      // Cleanup both mappings
      pendingRequests.delete(matchingHash);
      upstreamToHashMap.delete(responseQueryId);
      upstreamSocket.close();
    } else {
      console.warn(`⚠️ Received orphaned response with ID: ${responseQueryId}`);
      upstreamSocket.close();
    }
  });

  upstreamSocket.on("error", (err) => {
    console.error(`Failed to contact ${server.name}:`, err);
    cleanup();
    dnsForwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
  });

  // Cleanup function
  const cleanup = () => {
    if (pendingRequests.has(requestHash)) {
      pendingRequests.delete(requestHash);
    }
    if (upstreamToHashMap.has(upstreamQueryId)) {
      upstreamToHashMap.delete(upstreamQueryId);
    }
    upstreamSocket.close();
  };

  // Timeout for the upstream query
  setTimeout(() => {
    if (pendingRequests.has(requestHash)) {
      console.log(`⏰ Timeout ${requestHash.substring(0, 8)} - ${server.name}, trying next...`);
      cleanup();
      dnsForwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
    }
  }, 5000);

  // Create a udp socket to forward the query upstream
  upstreamSocket.send(upstreamQuery, server.port, server.ip, (err) => {
    if (err) {
      console.error(`Failed to contact ${server.name} (${server.ip}):`, err);
      cleanup();
      dnsForwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
    } else {
      console.log(`📤 Forwarded ${domain} to ${server.name} (${requestHash.substring(0, 8)})`);
      currentServerIndex = serverIndex;
    }
  });
};

// Main DNS query handler
dnsServer.on("message", (queryBuffer: Buffer, remoteAddr: dgram.RemoteInfo) => {
  try {
    const queryId = queryBuffer.readUInt16BE(0);
    const domain = parseDomainFromQuery(queryBuffer);
    
    console.log(`🔍 Query from ${remoteAddr.address}:${remoteAddr.port} - ${domain} (ID: ${queryId})`);

    const clientInfo: dnsRequest = {
      clientIP: remoteAddr.address,
      clientPort: remoteAddr.port,
      timestamp: Date.now(),
      queryId: queryId,
      upstreamQueryId: 0,
      domain: "",
      requestHash: ""
    };

    dnsForwardUpstream(queryBuffer, clientInfo, currentServerIndex);
  } catch (error) {
    console.error("Error processing DNS query:", error);
  }
});

// Periodic cleanup of stale requests
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [hash, request] of pendingRequests.entries()) {
    if (now - request.timestamp > 30000) { // 30 seconds timeout
      pendingRequests.delete(hash);
      upstreamToHashMap.delete(request.upstreamQueryId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned ${cleanedCount} stale requests`);
  }
}, 60000); // Clean every minute

// Error handling
dnsServer.on("error", (error) => {
  console.error("❌ DNS Server error:", error);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down DNS server...");
  console.log(`📊 Pending requests: ${pendingRequests.size}`);
  console.log(`📊 Upstream mappings: ${upstreamToHashMap.size}`);
  dnsServer.close(() => {
    console.log("DNS server stopped");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
  dnsServer.close(() => {
    console.log("✅ DNS server stopped");
    process.exit(0);
  });
});
