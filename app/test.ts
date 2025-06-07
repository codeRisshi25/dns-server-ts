import * as dgram from "dgram";
import { Buffer } from "buffer";

// --- Configuration ---
const DNS_SERVER_IP = "8.8.8.8";
const DNS_SERVER_PORT = 53;
const DOMAIN_TO_QUERY = "google.com";

// --- DNS Packet Builder ---

/**
 * Builds a DNS query packet as a Buffer.
 * @param domain The domain name to query.
 * @returns A Buffer containing the raw DNS query.
 */
function buildDnsQuery(domain: string): Buffer {
  // 1. Transaction ID (a random 16-bit number)
  const id = Math.floor(Math.random() * 65535);

  // 2. Header (12 bytes)
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);          // Transaction ID
  header.writeUInt16BE(0x0100, 2);      // Flags: 0x0100 for a standard query with recursion
  header.writeUInt16BE(1, 4);           // QDCOUNT: 1 question
  header.writeUInt16BE(0, 6);           // ANCOUNT: 0 answers
  header.writeUInt16BE(0, 8);           // NSCOUNT: 0 authority records
  header.writeUInt16BE(0, 10);          // ARCOUNT: 0 additional records

  // 3. Question Section
  const labels = domain.split(".");
  // Map each label to a buffer with [length, string] format
  const questionParts = labels.map(label => {
    const len = Buffer.from([label.length]);
    const str = Buffer.from(label, "ascii");
    return Buffer.concat([len, str]);
  });

  const questionName = Buffer.concat(questionParts);

  const question = Buffer.concat([
    questionName,
    Buffer.from([0]), // Null terminator for the name
    Buffer.from([0, 1]), // QTYPE: 1 for A record (IPv4)
    Buffer.from([0, 1]), // QCLASS: 1 for IN (Internet)
  ]);

  return Buffer.concat([header, question]);
}


// --- DNS Packet Parser ---
// These are similar to your server's functions, adapted for the client response.

function parseDnsHeader(buffer: Buffer) {
  const flags = buffer.readUInt16BE(2);
  return {
    id: buffer.readUInt16BE(0),
    flags: {
      qr: (flags & 0x8000) >> 15,
      opcode: (flags & 0x7800) >> 11,
      aa: (flags & 0x0400) >> 10,
      tc: (flags & 0x0200) >> 9,
      rd: (flags & 0x0100) >> 8,
      ra: (flags & 0x0080) >> 7,
      rcode: flags & 0x000F,
    },
    qdcount: buffer.readUInt16BE(4),
    ancount: buffer.readUInt16BE(6),
    nscount: buffer.readUInt16BE(8),
    arcount: buffer.readUInt16BE(10),
  };
}

/**
 * Decodes a domain name from a DNS packet, handling pointers.
 */
function decodeName(buffer: Buffer, offset: number): { name: string, newOffset: number } {
  let name = "";
  let currentOffset = offset;
  let jumped = false;
  let jumps = 0; // To prevent infinite loops

  while (buffer[currentOffset] !== 0 && jumps < 10) {
    const length = buffer[currentOffset];
    
    // Check if it's a pointer (first two bits are 11)
    if ((length & 0xC0) === 0xC0) {
      if (!jumped) {
        offset += 2; // Move past the 2-byte pointer
        jumped = true;
      }
      currentOffset = buffer.readUInt16BE(currentOffset) & 0x3FFF;
      jumps++;
      continue;
    }
    
    if (name.length > 0) {
      name += ".";
    }

    name += buffer.toString('ascii', currentOffset + 1, currentOffset + 1 + length);
    currentOffset += (length + 1);
    if (!jumped) {
      offset = currentOffset;
    }
  }

  if (!jumped) {
    offset++; // Move past the final null byte
  }

  return { name, newOffset: offset };
}

function parseDnsResponse(buffer: Buffer) {
    const header = parseDnsHeader(buffer);
    const answers: any[] = [];
    let offset = 12; // Start after the header

    // Skip over the question section
    for (let i = 0; i < header.qdcount; i++) {
        const { newOffset } = decodeName(buffer, offset);
        offset = newOffset + 4; // Add 4 bytes for QTYPE and QCLASS
    }

    // Parse the answer section
    for (let i = 0; i < header.ancount; i++) {
        const { name, newOffset } = decodeName(buffer, offset);
        offset = newOffset;

        const type = buffer.readUInt16BE(offset);
        const classVal = buffer.readUInt16BE(offset + 2);
        const ttl = buffer.readUInt32BE(offset + 4);
        const rdlength = buffer.readUInt16BE(offset + 8);
        offset += 10;
        
        let rdata;
        if (type === 1) { // A Record
            rdata = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
        } else {
            rdata = buffer.slice(offset, offset + rdlength).toString('hex');
        }

        answers.push({ name, type, class: classVal, ttl, rdlength, rdata });
        offset += rdlength;
    }

    return { header, answers };
}


// --- Main Execution ---

// 1. Create a UDP socket
const client = dgram.createSocket("udp4");

// 2. Build the DNS query packet
const queryBuffer = buildDnsQuery(DOMAIN_TO_QUERY);

// 3. Set up listeners for the response
client.on("message", (responseBuffer, rinfo) => {
  console.log(`\n--- Received Response from ${rinfo.address}:${rinfo.port} ---`);
  
  // Log the raw buffer for inspection
  console.log("Raw Response Buffer:", responseBuffer.toString('hex'));
  
  console.log("\n--- Parsed Response ---");
  try {
    const parsedResponse = parseDnsResponse(responseBuffer);
    console.log("Header:", JSON.stringify(parsedResponse.header, null, 2));
    console.log("Answers:", JSON.stringify(parsedResponse.answers, null, 2));
  } catch (e) {
      console.error("Failed to parse response:", e);
  }

  client.close(); // Close the socket and exit the program
});

client.on("error", (err) => {
  console.error(`Client error:\n${err.stack}`);
  client.close();
});

// 4. Send the query to Google's DNS server
client.send(queryBuffer, DNS_SERVER_PORT, DNS_SERVER_IP, (err) => {
  if (err) {
    console.error("Failed to send packet", err);
    client.close();
  } else {
    console.log(`--- Sent DNS Query for '${DOMAIN_TO_QUERY}' to ${DNS_SERVER_IP} ---`);
    console.log("Raw Query Buffer:", queryBuffer.toString('hex'));
  }
});