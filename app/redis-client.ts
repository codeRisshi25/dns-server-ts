// redis-client.ts
import { RedisClient } from "bun";
import { config } from "./config.ts";

export class DnsRedisClient {
  private client: RedisClient | null = null;
  private ready = false;

  async initialize(): Promise<void> {
    try {
      const redisUrl = `redis://${config.REDIS_HOST}:${config.REDIS_PORT}`;
      console.log(`🔗 Attempting Redis connection: ${redisUrl}`);
      
      this.client = new RedisClient(redisUrl);
      
      const pingPromise = this.client.send('PING', []);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Connection timeout")), 10000)
      );
      
      await Promise.race([pingPromise, timeoutPromise]);
      this.ready = true;
      
      console.log("✅ Redis connected successfully");
      
      await this.client.set("dns:startup", new Date().toISOString());
      const testValue = await this.client.get("dns:startup");
      console.log(`📝 Redis test write/read: ${testValue ? 'SUCCESS' : 'FAILED'}`);
      
    } catch (error) {
      console.error("❌ Redis connection failed:", error);
      console.log("⚠️ DNS server will run without caching");
      this.ready = false;
      this.client = null;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async cacheResponse(domain: string, response: Buffer, ttl: number = 300): Promise<void> {
    if (!this.ready || !this.client) return;
    
    try {
        const key = `dns:${domain.toLowerCase()}`;
        await this.client.set(key, response.toString('base64'));
        await this.client.expire(key, ttl);
      console.log(`💾 Cached ${domain} (TTL: ${ttl}s)`);
    } catch (error) {
      console.error("❌ Cache write error:", error);
    }
  }

  async getCachedResponse(domain: string): Promise<Buffer | null> {
    if (!this.ready || !this.client) return null;
    
    try {
      const key = `dns:${domain.toLowerCase()}`;
      const cached = await this.client.get(key);
      
      if (cached) {
        console.log(`🎯 Cache hit for ${domain}`);
        return Buffer.from(cached, 'base64');
      }
      
      return null;
    } catch (error) {
      console.error("❌ Cache read error:", error);
      return null;
    }
  }

  async incrementQueryCount(): Promise<void> {
    if (!this.ready || !this.client) return;
    
    try {
      await this.client.incr("dns:query_count");
    } catch (error) {
      console.error("❌ Query count increment error:", error);
    }
  }

  async getStats(): Promise<{ queries: number }> {
    if (!this.ready || !this.client) return { queries: 0 };
    
    try {
      const queries = parseInt(await this.client.get("dns:query_count") || "0");
      return { queries };
    } catch (error) {
      console.error("❌ Stats retrieval error:", error);
      return { queries: 0 };
    }
  }
}