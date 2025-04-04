import Redis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();

// More detailed connection options for local Redis
const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectTimeout: 5000,
  retryStrategy: (times: number) => {
    if (times > 3) {
      console.error(`Redis connection failed after ${times} attempts`);
      return null; // stop retrying
    }
    return Math.min(times * 200, 1000); // exponential backoff
  }
};

async function checkRedis() {
  console.log('Checking Redis connection at:', redisOptions.host, redisOptions.port);
  
  const redis = new Redis(redisOptions);
  
  redis.on('connect', () => {
    console.log('Connected to Redis successfully!');
  });
  
  redis.on('error', (err) => {
    console.error('Redis connection error:', err);
  });
  
  try {
    // Try to set and get a value
    await redis.set('test-key', 'Hello Redis');
    const value = await redis.get('test-key');
    console.log('Redis test value:', value);
    
    // Clean up
    await redis.del('test-key');
    await redis.quit();
    
    console.log('Redis is working properly');
  } catch (error) {
    console.error('Failed to perform Redis operations:', error);
    process.exit(1);
  }
}

checkRedis().catch(console.error);
