import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { updateTxStatus } from './db';
import { QUEUE_NAME, RESPONSE_QUEUE_NAME, responseQueue } from './queue';
import { TradeJobData, JobResult, JobStatus, TradeResponseData, ResponseType } from './types/job.types';

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

// Helper function to send response via response queue
async function sendResponse(response: TradeResponseData) {
  try {
    await responseQueue.add('response', response, {
      removeOnComplete: true
    });
    console.log(`Response sent for txId ${response.txId}: ${response.type}`);
  } catch (error) {
    console.error(`Error sending response for txId ${response.txId}:`, error);
  }
}

const worker = new Worker<TradeJobData, JobResult>(
  QUEUE_NAME,
  async job => {
    const { txId, to, data, amount, gasLimit } = job.data;

    try {
      // Step 1: Send simulation response
      const simulationResponse: TradeResponseData = {
        txId,
        type: ResponseType.SIMULATION,
        status: JobStatus.PENDING,
        timestamp: new Date().toISOString(),
        simulation: {
          estimatedGas: Number(gasLimit) || 100000,
          expectedOutput: amount || '0',
          priceImpact: '0.05%',
          route: [`0x${to.substring(2, 10)}`, `0x${(parseInt(to.substring(2, 10), 16) + 1).toString(16)}`]
        }
      };
      await sendResponse(simulationResponse);
      
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
      
      // Step 2: Send submission response
      const submissionResponse: TradeResponseData = {
        txId,
        type: ResponseType.SUBMISSION,
        status: JobStatus.PROCESSING,
        timestamp: new Date().toISOString(),
        txHash: tx.hash
      };
      await sendResponse(submissionResponse);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      
      if (receipt?.status === 0) {
        throw new Error('Transaction failed on-chain');
      }
      
      // Update status to completed
      await updateTxStatus(txId, JobStatus.COMPLETED, tx.hash);
      
      // Step 3: Send receipt response
      // Make sure receipt is not null
      if (receipt) {
        const receiptResponse: TradeResponseData = {
          txId,
          type: ResponseType.RECEIPT,
          status: JobStatus.COMPLETED,
          timestamp: new Date().toISOString(),
          txHash: tx.hash,
          receipt: {
            blockHash: receipt.blockHash,
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.index || 0,
            gasUsed: Number(receipt.gasUsed),
            status: receipt.status === 1,
            logs: receipt.logs.map(log => ({
              address: log.address,
              topics: log.topics,
              data: log.data
            }))
          }
        };
        await sendResponse(receiptResponse);
      }
      
      return { 
        success: true, 
        txHash: tx.hash 
      };
    } catch (error: any) {
      console.error(`Error processing transaction ${txId}:`, error);
      await updateTxStatus(txId, JobStatus.FAILED);
      
      // Extract error details for Ethereum errors
      const errorDetails: Record<string, any> = {};
      
      if (error.code) errorDetails.code = error.code;
      if (error.reason) errorDetails.reason = error.reason;
      if (error.transaction) errorDetails.transaction = error.transaction;
      if (error.shortMessage) errorDetails.shortMessage = error.shortMessage;
      
      // Include provider error info if available
      if (error.info && error.info.error) {
        errorDetails.info = {
          code: error.info.error.code,
          message: error.info.error.message
        };
      }
      
      // Send error response
      const errorResponse: TradeResponseData = {
        txId,
        type: ResponseType.ERROR,
        status: JobStatus.FAILED,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        errorDetails: {
          code: error.code,
          transaction: error.transaction,
          info: error.info,
          shortMessage: error.shortMessage
        }
      };
      await sendResponse(errorResponse);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        errorDetails
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

// Graceful shutdown handler for both SIGTERM and SIGINT (Ctrl+C)
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  
  try {
    // Close active connections in sequence
    console.log('Closing worker...');
    await worker.close();
    console.log('Worker closed successfully');
    
    console.log('Closing metrics queue...');
    await metricsQueue.close();
    console.log('Metrics queue closed successfully');
    
    console.log('Closing response queue...');
    await responseQueue.close();
    console.log('Response queue closed successfully');
    
    console.log('Closing Redis connection...');
    await connection.quit();
    console.log('Redis connection closed successfully');
    
    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    // Force exit after a timeout if graceful shutdown fails
    setTimeout(() => {
      console.error('Forcing exit after failed graceful shutdown');
      process.exit(1);
    }, 3000);
  }
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

