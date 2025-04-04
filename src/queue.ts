import { Queue } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import { TradeJobData, JobResult } from './types/job.types';

dotenv.config();

export const QUEUE_NAME = 'trade-queue';

// More detailed connection options for local Redis
const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times: number) => {
    if (times > 3) {
      console.error(`Redis connection failed after ${times} attempts`);
      return null; // stop retrying
    }
    return Math.min(times * 200, 1000); // exponential backoff
  }
};

console.log('Connecting to Redis at:', redisOptions.host, redisOptions.port);
const connection = new Redis(redisOptions);

export const tradeQueue = new Queue<TradeJobData, JobResult>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,  // Keep last 100 completed jobs
    removeOnFail: 100,      // Keep last 100 failed jobs
  },
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await tradeQueue.close();
});

process.on('SIGINT', async () => {
  await tradeQueue.close();
});

