// request-manager.ts
import { DnsRequest } from "./types.ts";

export class RequestManager {
  private pendingRequests = new Map<string, DnsRequest>();
  private upstreamToHashMap = new Map<number, string>();
  private requestCounter = 0;

  generateUniqueUpstreamId(): number {
    let upstreamQueryId: number;
    do {
      upstreamQueryId = Math.floor(Math.random() * 65535);
    } while (this.upstreamToHashMap.has(upstreamQueryId));
    return upstreamQueryId;
  }

  storeRequest(hash: string, request: DnsRequest): void {
    this.pendingRequests.set(hash, request);
    this.upstreamToHashMap.set(request.upstreamQueryId, hash);
  }

  getRequestByUpstreamId(upstreamId: number): DnsRequest | null {
    const hash = this.upstreamToHashMap.get(upstreamId);
    return hash ? this.pendingRequests.get(hash) || null : null;
  }

  getRequestByHash(hash: string): DnsRequest | null {
    return this.pendingRequests.get(hash) || null;
  }

  removeRequest(hash: string, upstreamId: number): void {
    this.pendingRequests.delete(hash);
    this.upstreamToHashMap.delete(upstreamId);
  }

  cleanupStaleRequests(timeoutMs: number = 30000): number {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [hash, request] of this.pendingRequests.entries()) {
      if (now - request.timestamp > timeoutMs) {
        this.pendingRequests.delete(hash);
        this.upstreamToHashMap.delete(request.upstreamQueryId);
        cleanedCount++;
      }
    }
    
    return cleanedCount;
  }

  getStats(): { pending: number, upstream: number } {
    return {
      pending: this.pendingRequests.size,
      upstream: this.upstreamToHashMap.size
    };
  }
}