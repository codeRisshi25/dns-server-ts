import dgram from "dgram";

class SimpleDnsClient {
  private client: dgram.Socket | null = null;
  private isActive = false;

  constructor() {
    this.client = dgram.createSocket("udp4");
    this.isActive = true;
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

  private closeClient() {
    if (this.client && this.isActive) {
      this.isActive = false;
      this.client.close();
      this.client = null;
    }
  }

  async queryDns(domain: string, serverPort: number = 8053): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.isActive) {
        console.error("❌ Client not available");
        resolve(null);
        return;
      }

      const queryId = Math.floor(Math.random() * 65535);
      const query = this.createDnsQuery(domain, queryId);
      
      console.log(`🔍 Querying ${domain} (ID: ${queryId}) from DNS server on port ${serverPort}...`);
      console.log(`📤 Query size: ${query.length} bytes`);

      let responseReceived = false;

      this.client.on("message", (response, remote) => {
        if (responseReceived) return;
        
        const responseId = response.readUInt16BE(0);
        
        // Only process responses that match our query ID
        if (responseId !== queryId) {
          return; // This response is for a different request
        }
        
        responseReceived = true;

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
            this.closeClient();
            resolve(ip);
          } else {
            console.log(`❌ No IP found in response`);
            this.closeClient();
            resolve(null);
          }
        } else {
          console.log(`❌ Invalid response or error code`);
          this.closeClient();
          resolve(null);
        }
      });

      this.client.on("error", (err) => {
        if (responseReceived) return;
        responseReceived = true;
        console.error(`❌ Client error: ${err.message}`);
        this.closeClient();
        reject(err);
      });

      // Set timeout
      const timeoutHandle = setTimeout(() => {
        if (!responseReceived) {
          responseReceived = true;
          console.log(`⏰ Query timeout for ${domain} - no response received`);
          this.closeClient();
          resolve(null);
        }
      }, 8000);

      // Send the query
      this.client.send(query, serverPort, "127.0.0.1", (err) => {
        if (err) {
          if (!responseReceived) {
            responseReceived = true;
            console.error(`❌ Failed to send query for ${domain}: ${err.message}`);
            clearTimeout(timeoutHandle);
            this.closeClient();
            reject(err);
          }
        }
      });
    });
  }
}

// Enhanced concurrent DNS testing
class ConcurrentDnsTest {
  private results: Map<string, string | null> = new Map();
  private startTime: number = 0;

  async testConcurrentRequests(domains: string[], maxConcurrent: number = 5, serverPort: number = 8053): Promise<void> {
    console.log(`🚀 Starting concurrent DNS test with ${domains.length} domains (max ${maxConcurrent} concurrent)`);
    console.log(`🎯 Target DNS server: 127.0.0.1:${serverPort}`);
    console.log(`📋 Domains: ${domains.join(', ')}\n`);
    
    this.startTime = Date.now();
    
    // Create promises for all domains
    const promises = domains.map(domain => this.queryDomain(domain, serverPort));
    
    try {
      // Execute all requests concurrently
      const results = await Promise.allSettled(promises);
      
      // Process results
      results.forEach((result, index) => {
        const domain = domains[index];
        if (result.status === 'fulfilled') {
          this.results.set(domain, result.value);
        } else {
          console.error(`❌ Failed to resolve ${domain}:`, result.reason);
          this.results.set(domain, null);
        }
      });
      
      this.printResults();
    } catch (error) {
      console.error("❌ Concurrent test failed:", error);
    }
  }

  private async queryDomain(domain: string, serverPort: number): Promise<string | null> {
    const client = new SimpleDnsClient();
    try {
      return await client.queryDns(domain, serverPort);
    } catch (error) {
      console.error(`❌ Error querying ${domain}:`, error);
      return null;
    }
  }

  private printResults(): void {
    const endTime = Date.now();
    const totalTime = endTime - this.startTime;
    
    console.log("\n" + "=".repeat(80));
    console.log("📊 CONCURRENT DNS TEST RESULTS");
    console.log("=".repeat(80));
    
    let successCount = 0;
    let failureCount = 0;
    
    this.results.forEach((ip, domain) => {
      if (ip) {
        console.log(`✅ ${domain.padEnd(25)} -> ${ip}`);
        successCount++;
      } else {
        console.log(`❌ ${domain.padEnd(25)} -> Failed`);
        failureCount++;
      }
    });
    
    console.log("\n" + "-".repeat(80));
    console.log(`📈 Success Rate: ${successCount}/${this.results.size} (${((successCount / this.results.size) * 100).toFixed(1)}%)`);
    console.log(`⏱️  Total Time: ${totalTime}ms`);
    console.log(`⚡ Average Time per Query: ${(totalTime / this.results.size).toFixed(1)}ms`);
    console.log("=".repeat(80));
  }
}

// Test functions for different scenarios

// Test 1: Basic concurrent test
async function testBasicConcurrent() {
  const tester = new ConcurrentDnsTest();
  const domains = ["google.com", "github.com", "stackoverflow.com", "cloudflare.com", "microsoft.com"];
  
  await tester.testConcurrentRequests(domains);
}

// Test 2: High concurrency test
async function testHighConcurrency() {
  const tester = new ConcurrentDnsTest();
  const domains = [
    "google.com", "github.com", "stackoverflow.com", "cloudflare.com", "microsoft.com",
    "amazon.com", "facebook.com", "twitter.com", "linkedin.com", "reddit.com",
    "youtube.com", "netflix.com", "apple.com", "adobe.com", "dropbox.com"
  ];
  
  console.log("\n🔥 HIGH CONCURRENCY TEST (15 domains simultaneously)");
  await tester.testConcurrentRequests(domains, 15);
}

// Test 3: Stress test with repeated queries
async function testStressTest() {
  console.log("\n💪 STRESS TEST - Multiple rounds of concurrent queries");
  
  const domains = ["google.com", "github.com", "stackoverflow.com"];
  const rounds = 3;
  
  for (let round = 1; round <= rounds; round++) {
    console.log(`\n🔄 Round ${round}/${rounds}`);
    const tester = new ConcurrentDnsTest();
    await tester.testConcurrentRequests(domains);
    
    if (round < rounds) {
      console.log("⏸️  Waiting 2 seconds before next round...");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Test 4: Mixed timing test
async function testMixedTiming() {
  console.log("\n⏰ MIXED TIMING TEST - Staggered concurrent requests");
  
  const domains = ["google.com", "github.com", "stackoverflow.com", "cloudflare.com"];
  const promises: Promise<void>[] = [];
  
  domains.forEach((domain, index) => {
    const promise = new Promise<void>(async (resolve) => {
      // Stagger requests by 200ms each
      await new Promise(r => setTimeout(r, index * 200));
      
      const client = new SimpleDnsClient();
      const result = await client.queryDns(domain);
      console.log(`⚡ Staggered result for ${domain}: ${result || 'Failed'}`);
      resolve();
    });
    
    promises.push(promise);
  });
  
  await Promise.all(promises);
}

// Main test runner
async function runAllTests() {
  console.log("🧪 COMPREHENSIVE CONCURRENT DNS TESTING\n");
  
  try {
    await testBasicConcurrent();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    await testHighConcurrency();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    await testStressTest();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    await testMixedTiming();
    
    console.log("\n🎉 All concurrent tests completed!");
  } catch (error) {
    console.error("❌ Test suite failed:", error);
  }
}

// Run the tests
runAllTests();