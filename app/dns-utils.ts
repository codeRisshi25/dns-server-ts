// dns-utils.ts
import crypto from "crypto";
import type { DnsRequest } from "./types.ts";

export function parseDomainFromQuery(queryBuffer: Buffer): string {
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

export function generateRequestHash(clientInfo: DnsRequest, domain: string): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  const requestKey = `${clientInfo.clientIP}:${clientInfo.clientPort}:${clientInfo.queryId}:${domain}:${timestamp}:${random}`;
  
  return crypto
    .createHash("sha256")
    .update(requestKey)
    .digest("hex")
    .substring(0, 16);
}