import { Queue } from 'bullmq';
import { QUEUE_NAME } from './queue';
import Redis from 'ioredis';

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

const connection = new Redis(redisOptions);

export async function getQueueMetrics() {
  const queue = new Queue(QUEUE_NAME, { connection });
  
  try {
    const [
      jobCounts,
      waitingJobs,
      activeJobs,
      completedJobs,
      failedJobs
    ] = await Promise.all([
      queue.getJobCounts(),
      queue.getJobs(['waiting'], 0, 100),
      queue.getJobs(['active'], 0, 100),
      queue.getJobs(['completed'], 0, 100),
      queue.getJobs(['failed'], 0, 100)
    ]);

    return {
      counts: jobCounts,
      jobs: {
        waiting: waitingJobs.map(job => ({
          id: job.id,
          timestamp: job.timestamp,
          data: job.data
        })),
        active: activeJobs.map(job => ({
          id: job.id,
          timestamp: job.timestamp,
          data: job.data
        })),
        completed: completedJobs.map(job => ({
          id: job.id,
          timestamp: job.timestamp,
          data: job.data,
          returnvalue: job.returnvalue
        })),
        failed: failedJobs.map(job => ({
          id: job.id,
          timestamp: job.timestamp,
          data: job.data,
          failedReason: job.failedReason
        }))
      }
    };
  } finally {
    await queue.close();
  }
}
