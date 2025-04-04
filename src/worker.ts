import { Worker } from 'bullmq';
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

const connection = new Redis(process.env.REDIS_HOST || 'localhost', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

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

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.close();
});

process.on('SIGINT', async () => {
  await worker.close();
});

