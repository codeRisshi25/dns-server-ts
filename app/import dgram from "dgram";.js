import dgram from "dgram";

interface DnsRequest {
    clientIP: string;
    clientPort: number;
    timestamp: number;
    queryId: number;
}

// Track pending upstream requests
const pendingRequests = new Map<string, DnsRequest>();

// Local DNS records - your projects and services
const LOCAL_RECORDS = new Map([
    // Development projects
    ['myapp.local', '192.168.1.100'],
    ['api.myapp.local', '192.168.1.100'],
    ['admin.myapp.local', '192.168.1.100'],
    
    // Different services
    ['database.local', '192.168.1.101'],
    ['redis.local', '192.168.1.102'],
    ['nginx.local', '192.168.1.103'],
    
    // Project environments
    ['project1.dev', '192.168.1.110'],
    ['project2.dev', '192.168.1.111'],
    ['staging.myapp.dev', '192.168.1.120'],
    
    // Common local services
    ['router.local', '192.168.1.1'],
    ['printer.local', '192.168.1.50'],
]);

// Upstream DNS servers (fallback)
const UPSTREAM_DNS = [
    { ip: "1.1.1.1", port: 53, name: "Cloudflare" },
    { ip: "8.8.8.8", port: 53, name: "Google" },
    { ip: "9.9.9.9", port: 53, name: "Quad9" },
];

let currentUpstreamIndex = 0;

const dnsServer: dgram.Socket = dgram.createSocket("udp4");
dnsServer.bind(53, "0.0.0.0", () => {
    console.log("🚀 Recursive DNS Server listening on 0.0.0.0:53");
    console.log("📋 Local records configured:");
    LOCAL_RECORDS.forEach((ip, domain) => {
        console.log(`   ${domain} -> ${ip}`);
    });
});

// Parse domain name from DNS query
function parseDomainFromQuery(queryBuffer: Buffer): string {
    let offset = 12; // Skip DNS header
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

// Check if we have a local record
function getLocalRecord(domain: string): string | null {
    // Direct match
    if (LOCAL_RECORDS.has(domain)) {
        return LOCAL_RECORDS.get(domain)!;
    }
    
    // Wildcard patterns
    if (domain.endsWith('.local')) {
        return '127.0.0.1'; // Default local resolution
    }
    
    if (domain.endsWith('.dev')) {
        return '192.168.1.200'; // Development environment default
    }
    
    // Docker pattern
    if (domain.match(/^[\w-]+\.docker$/)) {
        return '127.0.0.1';
    }
    
    return null; // No local record found
}

// Create DNS response for local records
function createLocalResponse(queryBuffer: Buffer, ip: string): Buffer {
    const response = Buffer.alloc(512);
    let offset = 0;
    
    // Copy query ID
    queryBuffer.copy(response, offset, 0, 2);
    offset += 2;
    
    // Set response flags: QR=1, AA=1, RD=1, RA=1
    response.writeUInt16BE(0x8580, offset);
    offset += 2;
    
    // Counts: 1 question, 1 answer, 0 authority, 0 additional
    response.writeUInt16BE(1, offset); offset += 2; // QDCOUNT
    response.writeUInt16BE(1, offset); offset += 2; // ANCOUNT
    response.writeUInt16BE(0, offset); offset += 2; // NSCOUNT
    response.writeUInt16BE(0, offset); offset += 2; // ARCOUNT
    
    // Copy question section
    const questionStart = 12;
    let questionEnd = questionStart;
    while (queryBuffer[questionEnd] !== 0) {
        const labelLength = queryBuffer[questionEnd];
        questionEnd += labelLength + 1;
    }
    questionEnd += 5; // null + type + class
    
    queryBuffer.copy(response, offset, questionStart, questionEnd);
    offset += (questionEnd - questionStart);
    
    // Add answer section
    response.writeUInt16BE(0xc00c, offset); offset += 2; // Compression pointer
    response.writeUInt16BE(1, offset); offset += 2;      // Type A
    response.writeUInt16BE(1, offset); offset += 2;      // Class IN
    response.writeUInt32BE(300, offset); offset += 4;    // TTL (5 minutes)
    response.writeUInt16BE(4, offset); offset += 2;      // Data length
    
    // IP address
    const ipParts = ip.split('.');
    for (let i = 0; i < 4; i++) {
        response.writeUInt8(parseInt(ipParts[i]), offset++);
    }
    
    return response.slice(0, offset);
}

// Forward query to upstream DNS
function forwardToUpstream(queryBuffer: Buffer, clientInfo: DnsRequest, upstreamIndex: number = 0) {
    if (upstreamIndex >= UPSTREAM_DNS.length) {
        console.error("❌ All upstream DNS servers failed");
        return;
    }
    
    const upstream = UPSTREAM_DNS[upstreamIndex];
    const requestKey = `${clientInfo.queryId}-${clientInfo.clientIP}-${clientInfo.clientPort}`;
    
    // Store client info for response correlation
    pendingRequests.set(requestKey, clientInfo);
    
    // Create socket for upstream query
    const upstreamSocket = dgram.createSocket('udp4');
    
    upstreamSocket.on('message', (response, rinfo) => {
        console.log(`📥 Response from ${upstream.name} for external query`);
        
        // Forward response back to original client
        dnsServer.send(response, clientInfo.clientPort, clientInfo.clientIP, (err) => {
            if (err) {
                console.error("Error sending response to client:", err);
            }
        });
        
        // Cleanup
        pendingRequests.delete(requestKey);
        upstreamSocket.close();
    });
    
    upstreamSocket.on('error', (err) => {
        console.error(`❌ Error with ${upstream.name}:`, err);
        upstreamSocket.close();
        pendingRequests.delete(requestKey);
        
        // Try next upstream server
        forwardToUpstream(queryBuffer, clientInfo, upstreamIndex + 1);
    });
    
    // Set timeout for upstream query
    setTimeout(() => {
        if (pendingRequests.has(requestKey)) {
            console.log(`⏰ Timeout with ${upstream.name}, trying next...`);
            upstreamSocket.close();
            pendingRequests.delete(requestKey);
            forwardToUpstream(queryBuffer, clientInfo, upstreamIndex + 1);
        }
    }, 5000);
    
    // Send query to upstream
    upstreamSocket.send(queryBuffer, upstream.port, upstream.ip, (err) => {
        if (err) {
            console.error(`Failed to send to ${upstream.name}:`, err);
            upstreamSocket.close();
            pendingRequests.delete(requestKey);
            forwardToUpstream(queryBuffer, clientInfo, upstreamIndex + 1);
        } else {
            console.log(`📤 Forwarded to ${upstream.name} (${upstream.ip})`);
        }
    });
}

// Main DNS query handler
dnsServer.on("message", (queryBuffer: Buffer, remoteAddr: dgram.RemoteInfo) => {
    try {
        const domain = parseDomainFromQuery(queryBuffer);
        const queryId = queryBuffer.readUInt16BE(0);
        
        console.log(`🔍 DNS Query from ${remoteAddr.address}:${remoteAddr.port} for: ${domain}`);
        
        // Check local records first
        const localIP = getLocalRecord(domain);
        
        if (localIP) {
            // Serve from local records
            console.log(`✅ Local record: ${domain} -> ${localIP}`);
            const response = createLocalResponse(queryBuffer, localIP);
            dnsServer.send(response, remoteAddr.port, remoteAddr.address, (err) => {
                if (err) {
                    console.error("Error sending local response:", err);
                }
            });
        } else {
            // Forward to upstream DNS (recursive resolution)
            console.log(`🌐 Forwarding to upstream: ${domain}`);
            const clientInfo: DnsRequest = {
                clientIP: remoteAddr.address,
                clientPort: remoteAddr.port,
                timestamp: Date.now(),
                queryId: queryId
            };
            forwardToUpstream(queryBuffer, clientInfo, currentUpstreamIndex);
        }
    } catch (error) {
        console.error("❌ Error processing DNS query:", error);
    }
});

// Error handling
dnsServer.on("error", (error) => {
    console.error("❌ DNS Server error:", error);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down DNS server...');
    dnsServer.close(() => {
        console.log('✅ DNS server stopped');
        process.exit(0);
    });
});

// Helper functions for dynamic record management
export function addLocalRecord(domain: string, ip: string): void {
    LOCAL_RECORDS.set(domain.toLowerCase(), ip);
    console.log(`➕ Added: ${domain} -> ${ip}`);
}

export function removeLocalRecord(domain: string): boolean {
    const removed = LOCAL_RECORDS.delete(domain.toLowerCase());
    if (removed) {
        console.log(`➖ Removed: ${domain}`);
    }
    return removed;
}

export function listLocalRecords(): void {
    console.log("📋 Current local records:");
    LOCAL_RECORDS.forEach((ip, domain) => {
        console.log(`   ${domain} -> ${ip}`);
    });
}

console.log("🎯 DNS Server ready! Add your projects to LOCAL_RECORDS and enjoy easy local development!");