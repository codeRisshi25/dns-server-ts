import dgram from "dgram";

class SimpleDnsClient {
  private client: dgram.Socket;

  constructor() {
    this.client = dgram.createSocket("udp4");
  }

  // Create a DNS query packet
  private createDnsQuery(domain: string, queryId: number = Math.floor(Math.random() * 65535)): Buffer {
    const query = Buffer.alloc(256);
    let offset = 0;

    // DNS Header (12 bytes)
    query.writeUInt16BE(queryId, offset); offset += 2;      // ID
    query.writeUInt16BE(0x0100, offset); offset += 2;       // Flags (standard query, RD=1)
    query.writeUInt16BE(1, offset); offset += 2;            // QDCOUNT (1 question)
    query.writeUInt16BE(0, offset); offset += 2;            // ANCOUNT
    query.writeUInt16BE(0, offset); offset += 2;            // NSCOUNT
    query.writeUInt16BE(0, offset); offset += 2;            // ARCOUNT

    // Question section
    const labels = domain.split('.');
    for (const label of labels) {
      query.writeUInt8(label.length, offset++);
      query.write(label, offset);
      offset += label.length;
    }
    query.writeUInt8(0, offset++);                          // Null terminator
    query.writeUInt16BE(1, offset); offset += 2;            // QTYPE (A record)
    query.writeUInt16BE(1, offset); offset += 2;            // QCLASS (IN)

    return query.slice(0, offset);
  }

  // Parse IP address from DNS response
  private parseResponse(response: Buffer): string | null {
    try {
      // Skip header (12 bytes) and question section to find answer
      let offset = 12;
      
      // Skip question section
      while (response[offset] !== 0) {
        const labelLength = response[offset];
        offset += labelLength + 1;
      }
      offset += 5; // null terminator + type + class
      
      // Check if we have an answer
      const ancount = response.readUInt16BE(6);
      if (ancount === 0) return null;
      
      // Skip name compression pointer (2 bytes)
      offset += 2;
      
      // Skip type (2), class (2), TTL (4), data length (2)
      offset += 10;
      
      // Read IP address (4 bytes)
      const ip = `${response[offset]}.${response[offset + 1]}.${response[offset + 2]}.${response[offset + 3]}`;
      return ip;
    } catch (error) {
      console.error("Error parsing response:", error);
      return null;
    }
  }

  async queryDns(domain: string, serverPort: number = 8053): Promise<void> {
    const queryId = Math.floor(Math.random() * 65535);
    const query = this.createDnsQuery(domain, queryId);
    
    console.log(`🔍 Querying ${domain} (ID: ${queryId}) from DNS server on port ${serverPort}...`);
    console.log(`📤 Query size: ${query.length} bytes`);

    this.client.on("message", (response, remote) => {
      const responseId = response.readUInt16BE(0);
      const flags = response.readUInt16BE(2);
      const isResponse = (flags & 0x8000) !== 0;
      const rcode = flags & 0x000F;
      
      console.log(`\n📥 Received response from ${remote.address}:${remote.port}`);
      console.log(`📋 Response ID: ${responseId} (Expected: ${queryId})`);
      console.log(`✅ Is Response: ${isResponse}`);
      console.log(`📊 Response Code: ${rcode} (0=No Error)`);
      console.log(`📦 Response size: ${response.length} bytes`);
      
      if (responseId === queryId && rcode === 0) {
        const ip = this.parseResponse(response);
        if (ip) {
          console.log(`🎯 Resolved: ${domain} -> ${ip}`);
        } else {
          console.log(`❌ No IP found in response`);
        }
      } else {
        console.log(`❌ Invalid response or error code`);
      }
      
      this.client.close();
    });

    this.client.on("error", (err) => {
      console.error(`❌ Client error: ${err.message}`);
      this.client.close();
    });

    // Set timeout
    setTimeout(() => {
      console.log("⏰ Query timeout - no response received");
      this.client.close();
    }, 10000);

    // Send the query
    this.client.send(query, serverPort, "127.0.0.1", (err) => {
      if (err) {
        console.error(`❌ Failed to send query: ${err.message}`);
        this.client.close();
      }
    });
  }
}

// Test the DNS client
async function testDnsForwarding() {
  const client = new SimpleDnsClient();
  
  console.log("🧪 Testing DNS Forwarding Server...\n");
  
  // Test multiple domains
  const testDomains = ["google.com", "github.com", "stackoverflow.com"];
  
  for (const domain of testDomains) {
    console.log(`\n${"=".repeat(50)}`);
    await new Promise(resolve => {
      setTimeout(async () => {
        const testClient = new SimpleDnsClient();
        await testClient.queryDns(domain);
        resolve(void 0);
      }, 2000);
    });
  }
}

// Run the test
testDnsForwarding();