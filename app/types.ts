// types.ts
export interface DnsRequest {
  clientIP: string;
  clientPort: number;
  timestamp: number;
  queryId: number;
  upstreamQueryId: number;
  domain: string;
  requestHash: string;
}

export interface DnsServer {
  ip: string;
  port: number;
  name: string;
}