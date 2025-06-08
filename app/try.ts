import dgram from "dgram";
import crypto from "crypto";

// datastructure for dns requests from clients
interface dnsRequest {
  clientIP: string;
  clientPort: number;
  timestamp: number;
  queryId: number;
  upstreamQueryId: number;
}

// hold the dnsRequest pairs
let pendingRequests = new Map<string, dnsRequest>();

// --- Configuration ---
// DNS server pool
const DNS_SERVERS = [
  { ip: "8.8.8.8", port: 53, name: "Google Primary" },
  { ip: "1.1.1.1", port: 53, name: "Cloudflare Primary" },
  { ip: "9.9.9.9", port: 53, name: "Quad9 Primary" },
];

let currentServerIndex = 0;

// create the dns server on localhost ( development )
const dnsServer: dgram.Socket = dgram.createSocket("udp4");
dnsServer.bind(8053, "127.0.0.1", () => {
  console.log("🚀 DNS Server listening on 127.0.0.1:8053");
});

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

  //* Generate unique queryID for upstream
  const upstreamQueryId = Math.floor(Math.random() * 65535);
  clientInfo.upstreamQueryId = upstreamQueryId;

  // Create modified query for upstream
  const upstreamQuery = Buffer.from(queryBuffer);
  upstreamQuery.writeUInt16BE(upstreamQueryId, 0);

  const requestKey = `${clientInfo.clientIP}:${clientInfo.clientPort}:${
    clientInfo.queryId
  }:${Date.now()}`;
  const requestid = crypto
    .createHash("sha256")
    .update(requestKey)
    .digest("hex")
    .substring(0, 16);

  // Adding the query to the Map
  pendingRequests.set(requestid, clientInfo);
  const upstreamSocket: dgram.Socket = dgram.createSocket("udp4");

  // Handle responses from the upstream server
  upstreamSocket.on("message", (response: Buffer) => {
    const responseQueryId = response.readUInt16BE(0);

    // Check if this response matches upstream query ID
    if (responseQueryId === upstreamQueryId && pendingRequests.has(requestid)) {
      const originalRequest = pendingRequests.get(requestid)!;
      console.log(
        `📥 Response from ${server.name} for client ${originalRequest.clientIP}:${originalRequest.clientPort}`
      );
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

      pendingRequests.delete(requestid);
      upstreamSocket.close();
    } else {
      console.warn(
        `⚠️ Received response with mismatched ID: ${responseQueryId}, expected: ${upstreamQueryId}`
      );
    }
  });

  upstreamSocket.on("error", (err) => {
    console.error(`Failed to contact ${server.name}:`, err);
    upstreamSocket.close();
    if (pendingRequests.has(requestid)) {
      pendingRequests.delete(requestid);
      dnsForwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
    }
  });

  // Timeout for the upstream query
  setTimeout(() => {
    if (pendingRequests.has(requestid)) {
      console.log(`⏰ Timeout with ${server.name}, trying next...`);
      upstreamSocket.close();
      pendingRequests.delete(requestid);
      dnsForwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
    }
  }, 5000);

  // Create a udp socket to forward the query upstream
  upstreamSocket.send(upstreamQuery, server.port, server.ip, (err) => {
    if (err) {
      console.error(`Failed to contact ${server.name} (${server.ip}):`, err);
      upstreamSocket.close();
      if (pendingRequests.has(requestid)) {
        pendingRequests.delete(requestid);
        dnsForwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
      }
    } else {
      console.log(
        `📤 Forwarded DNS Query to ${server.name} (Hash: ${requestid})`
      );
      currentServerIndex = serverIndex;
    }
  });
};

// Main DNS query handler
dnsServer.on("message", (queryBuffer: Buffer, remoteAddr: dgram.RemoteInfo) => {
  try {
    const queryId = queryBuffer.readUInt16BE(0);
    console.log(
      `🔍 DNS Query from ${remoteAddr.address}:${remoteAddr.port} (ID: ${queryId})`
    );

    const clientInfo: dnsRequest = {
      clientIP: remoteAddr.address,
      clientPort: remoteAddr.port,
      timestamp: Date.now(),
      queryId: queryId,
      upstreamQueryId: 0,
    };

    dnsForwardUpstream(queryBuffer, clientInfo, currentServerIndex);
  } catch (error) {
    console.error("Error processing DNS query:", error);
  }
});

// Error handling
dnsServer.on("error", (error) => {
  console.error("❌ DNS Server error:", error);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down DNS server...");
  dnsServer.close(() => {
    console.log("DNS server stopped");
    process.exit(0);
  });
});
