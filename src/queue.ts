import { Queue } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import { TradeJobData, JobResult } from './types/job.types';

dotenv.config();

export const QUEUE_NAME = 'trade-queue';

const connection = new Redis(process.env.REDIS_HOST || 'localhost', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});



export const tradeQueue = new Queue<TradeJobData, JobResult>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
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

