import dgram from "dgram";
import crypto from "crypto";

// datastructure for dns requests from clients
interface dnsRequest {
  clientIP: string;
  clientPort: number;
  timestamp: number;
  queryId : number;
  upstreamQueryId: number;
}

// hold the dnsRequest pairs
let pendingRequests = new Map<string, dnsRequest>();

// --- Configuration ---
// DNS server pool
const DNS_SERVERS = [
  { ip: "1.1.1.1", port: 53, name: "Cloudflare Primary" },
  { ip: "1.0.0.1", port: 53, name: "Cloudflare Secondary" },
  { ip: "8.8.8.8", port: 53, name: "Google Primary" },
  { ip: "8.8.4.4", port: 53, name: "Google Secondary" },
  { ip: "9.9.9.9", port: 53, name: "Quad9 Primary" },
  { ip: "149.112.112.112", port: 53, name: "Quad9 Secondary" },
  { ip: "208.67.222.222", port: 53, name: "OpenDNS Primary" },
  { ip: "208.67.220.220", port: 53, name: "OpenDNS Secondary" },
  { ip: "95.85.95.85", port: 53, name: "G-Core Primary" },
  { ip: "2.56.220.2", port: 53, name: "G-Core Secondary" },
];

// Use first server as default, but will try others if this fails
let currentServerIndex = 0;

// create the dns server on localhost ( development )
const dnsServer: dgram.Socket = dgram.createSocket("udp4");
dnsServer.bind(8053, "127.0.0.1", () => {
  console.log("🚀 DNS Server listening on 127.0.0.1:2053");
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

  //? generate unique queryID for upstream
  const upstreamQueryId = Math.floor(Math.random()*6555);
  clientInfo.upstreamQueryId = upstreamQueryId;

  // change the actual query for upstream responses\
  const upstreamQuery = Buffer.from(queryBuffer);
  upstreamQuery.writeUInt16BE(upstreamQueryId,0);
  
  const requestKey = `${clientInfo.clientIP}:${clientInfo.clientPort}:${clientInfo.queryId}:${Date.now()}`;
  const requestid = crypto
    .createHash("sha256")
    .update(requestKey)
    .digest("hex")
    .substring(0,16);

  //? Adding the query to the Map , comes in handy later
  pendingRequests.set(requestid, clientInfo);
  const upstreamSocket: dgram.Socket = dgram.createSocket("udp4");

  //* Handle responses from the upstream server
  upstreamSocket.on("message", (response: Buffer) => {
    console.log(`📥 Response from ${server.name} for external query`);

    // Send response back to the original client ( cool )
    dnsServer.send(
      response,
      clientInfo.clientPort,
      clientInfo.clientIP,
      (err) => {
        if (err) console.error("Error sending response to the client", err);
      }
    );
    pendingRequests.delete(requestid);
    upstreamSocket.close();
  });

  //! Time out for the upstream query
  setTimeout(() => {
    if (pendingRequests.has(requestid)) {
      console.log(`⏰ Timeout with ${server.name}, trying next...`);
      upstreamSocket.close();
      pendingRequests.delete(requestid);
      dnsForwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
    }
  }, 5000);

  //* Create a udp socket to forward the query upstream
  upstreamSocket.send(upstreamQuery, server.port, server.ip, (err) => {
    if (err) {
      console.error(`Failed to contact ${server.name} (${server.ip}):`, err);
      upstreamSocket.close();
      pendingRequests.delete(requestid);
      dnsForwardUpstream(queryBuffer, clientInfo, serverIndex + 1);
    } else {
      console.log(
        `---Forwarded DNS Query to ${server.name} (${server.ip}) ---`
      );
      console.log("Query Buffer:", queryBuffer.toString("hex"));
      currentServerIndex = serverIndex; //? Remember the working server for next time
    }
  });
};

//* Main DNS query handler
dnsServer.on("message", (queryBuffer: Buffer, remoteAddr: dgram.RemoteInfo) => {
  try {
    //? Forward the DNS query to one of the servers in the pool
    const queryId = queryBuffer.readUInt16BE(0);
    console.log(`DNS Query from ${remoteAddr.address}:${remoteAddr.port}`);
    console.log(`Forwarding to upstream`);
    const clientInfo : dnsRequest = {
        clientIP: remoteAddr.address,
        clientPort : remoteAddr.port,
        timestamp : Date.now(),
        queryId : queryId,
        upstreamQueryId : 0
    }
    dnsForwardUpstream(queryBuffer, clientInfo, currentServerIndex);
  } catch (error) {
    console.error("Error processing DNS query:", error);
  }
});

// Error handling
dnsServer.on("error", (error) => {
  console.error("❌ DNS Server error:", error);
});

//! Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down DNS server...');
    dnsServer.close(() => {
        console.log('DNS server stopped');
        process.exit(0);
    });
});

