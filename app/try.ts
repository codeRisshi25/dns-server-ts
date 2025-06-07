import dgram from "dgram";


interface dnsRequest {
    clientIP : string,
    clientPort : number;
    timestamp : number;
    queryId : number;
}

// hold the dnsRequest pairs
let dnsRequestsHandle = new Map<string,dnsRequest>();

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

const udpSocket: dgram.Socket = dgram.createSocket("udp4");
udpSocket.bind(8053, "127.0.0.1", () => {
  console.log("Listening on port 127.0.0.1:8053");
});

const dnsForward = (
  udpSocket: dgram.Socket,
  queryBuffer: Buffer,
  remoteAddr: dgram.RemoteInfo,
  serverIndex: number = 0
) => {
  if (serverIndex >= DNS_SERVERS.length) {
    console.error("All DNS servers failed");
    return;
  }

  const server = DNS_SERVERS[serverIndex];

  udpSocket.send(queryBuffer, server.port, server.ip, (err) => {
    if (err) {
      console.error(`Failed to contact ${server.name} (${server.ip}):`, err);
      dnsForward(udpSocket, queryBuffer, remoteAddr, serverIndex + 1);
    } else {
      console.log(
        `---Forwarded DNS Query to ${server.name} (${server.ip}) ---`
      );
      console.log("Query Buffer:", queryBuffer.toString("hex"));
      currentServerIndex = serverIndex; // Remember the working server for next time
    }
  });
};


//* this handles a dns query from a client 
udpSocket.on("message", (data: Buffer, remoteAddr: dgram.RemoteInfo) => {
  try {
    // Forward the DNS query to one of the servers in the pool
    dnsForward(udpSocket, data, remoteAddr, currentServerIndex);
  } catch (error) {
    console.error("Error processing DNS query:", error);
  }
});

// Handle responses from DNS servers and forward them back to the client
udpSocket.on("message", (response: Buffer, rinfo: dgram.RemoteInfo) => {
  try {
    // Here you would typically send the response back to the client
    // This would require tracking which client sent which query
    console.log(`Received response from ${rinfo.address}:${rinfo.port}`);

    // For a complete implementation, you'd need to track request-response pairs
    // and forward the response to the original requester
  } catch (error) {
    console.error("Error handling DNS response:", error);
  }
});
// Handle errors
udpSocket.on("error", (error) => {
  console.error("Socket error:", error);
});
