import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { updateTxStatus } from './db';
import { QUEUE_NAME } from './queue';
import { TradeJobData, JobResult, JobStatus } from './types/job.types';

dotenv.config();

if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY environment variable is not set');
}

if (!process.env.RPC_URL) {
  throw new Error('RPC_URL environment variable is not set');
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

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

const worker = new Worker<TradeJobData, JobResult>(
  QUEUE_NAME,
  async job => {
    const { txId, to, data, amount, gasLimit } = job.data;

    try {
      // Update status to processing
      await updateTxStatus(txId, JobStatus.PROCESSING);

      // Prepare transaction
      const txParams: ethers.TransactionRequest = {
        to,
        data,
      };

      if (amount) {
        txParams.value = amount;
      }

      if (gasLimit) {
        txParams.gasLimit = gasLimit;
      }

      // Send transaction
      const tx = await wallet.sendTransaction(txParams);
      console.log(`Transaction sent: ${tx.hash}`);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      
      if (receipt?.status === 0) {
        throw new Error('Transaction failed');
      }
      
      // Update status to completed
      await updateTxStatus(txId, JobStatus.COMPLETED, tx.hash);
      
      return { 
        success: true, 
        txHash: tx.hash 
      };
    } catch (error) {
      console.error(`Error processing transaction ${txId}:`, error);
      await updateTxStatus(txId, JobStatus.FAILED);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  },
  { 
    connection,
    concurrency: 5,
    removeOnComplete: {
      count: 100
    },
    removeOnFail: {
      count: 100
    }
  }
);

// Monitor all worker events
worker.on('active', job => {
  console.log(`Job ${job.id} has started processing`);
});

worker.on('completed', (job, result) => {
  if (result.success) {
    console.log(`Job ${job.id} completed successfully. TX Hash: ${result.txHash}`);
  } else {
    console.log(`Job ${job.id} completed with failure: ${result.error}`);
  }
});

worker.on('failed', (job, error) => {
  console.error(`Job ${job?.id} failed with error:`, error);
});

worker.on('error', error => {
  console.error('Worker error:', error);
});

worker.on('stalled', jobId => {
  console.warn(`Job ${jobId} has stalled`);
});

worker.on('progress', (job, progress) => {
  console.log(`Job ${job.id} is ${progress}% complete`);
});

// Log queue metrics every 30 seconds
const metricsQueue = new Queue(QUEUE_NAME, { connection });
setInterval(async () => {
  try {
    const jobCounts = await metricsQueue.getJobCounts();
    console.log('Queue metrics:', jobCounts);
  } catch (error) {
    console.error('Error getting queue metrics:', error);
  }
}, 30000);

// Clean up metrics queue on shutdown
process.on('SIGTERM', async () => {
  await metricsQueue.close();
});

process.on('SIGINT', async () => {
  await metricsQueue.close();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.close();
});

process.on('SIGINT', async () => {
  await worker.close();
});

