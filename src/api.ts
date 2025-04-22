import express from 'express';
import { Worker, QueueEvents, WorkerOptions } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import { tradeQueue, responseQueue, QUEUE_NAME, RESPONSE_QUEUE_NAME } from './queue';
import { pool } from './db';
import { v4 as uuidv4 } from 'uuid';
import { JobStatus, TradeResponseData, ResponseType } from './types/job.types';
import { getQueueMetrics } from './monitor';
import { sseClients, sendSSEUpdate, closeSSEConnection, registerSSEClient } from './utils/sse.utils';
import { formatAmount } from './utils/eth.utils';

dotenv.config();

const app = express();
app.use(express.json());

// Set up Redis connection
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

// Set up queue events for tracking job completions
const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

// Set up response queue worker to process responses from the worker
const responseWorker = new Worker<TradeResponseData, void>(
  RESPONSE_QUEUE_NAME, 
  async (job: any) => {
    const response = job.data;
    console.log(`Received response for txId ${response.txId}: ${response.type}`);
    
    // Forward the response to the client via SSE
    sendSSEUpdate(response.txId, response);
    
    // Close the SSE connection if this is the final response (receipt or error)
    if (response.type === ResponseType.RECEIPT || response.type === ResponseType.ERROR) {
      // Give the client a moment to process the final message before closing
      setTimeout(() => closeSSEConnection(response.txId), 500);
    }
  },
  { connection }
);

// Handle worker events
responseWorker.on('completed', (job: any) => {
  console.log(`Response job ${job.id} processed successfully`);
});

responseWorker.on('failed', (job, error) => {
  console.error(`Response job ${job?.id} failed:`, error);
});

app.post('/trade', async (req, res) => {
  try {
    const { to, data, amount, gasLimit } = req.body;
    const isSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');
    
    if (!to || !data) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required parameters: to and data are required' 
      });
    }
    
    // Format amount to wei
    let formattedAmount;
    try {
      formattedAmount = formatAmount(amount);
    } catch (e: any) {
      return res.status(400).json({
        success: false,
        error: e.message
      });
    }
    
    // Create transaction record
    const txId = uuidv4();
    await pool.query(
      'INSERT INTO transactions (id, status, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())',
      [txId, JobStatus.PENDING]
    );
    console.log('Transaction record created:', txId);
    
    // Add to queue
    const job = await tradeQueue.add('trade', {
      txId,
      to,
      data,
      amount: formattedAmount,
      gasLimit
    });
    console.log('Transaction added to queue:', job.id, 'for txId:', txId);
    
    if (isSSE) {
      // Register this client to receive SSE updates with disconnect tracking
      registerSSEClient(txId, res, req);
      
      // Send initial connection message
      const initialMessage = {
        event: 'connected',
        txId,
        status: JobStatus.PENDING,
        timestamp: new Date().toISOString(),
        message: 'Connected to trade stream. Waiting for worker responses...'
      };
      res.write(`data: ${JSON.stringify(initialMessage)}\n\n`);
    } else {
      // For regular HTTP clients (like curl), process the request synchronously
      // Add to queue
      const job = await tradeQueue.add('trade', {
        txId,
        to,
        data,
        amount: formattedAmount,
        gasLimit
      });
      console.log('Transaction added to queue:', job.id, 'for txId:', txId);
      
      // For non-SSE clients, wait for the job to complete with a timeout
      try {
        // Wait for job completion with a timeout
        const result = await job.waitUntilFinished(queueEvents, 10000); // 10 second timeout
        
        if (result && result.success) {
          // Job completed successfully
          await pool.query(
            'UPDATE transactions SET status = $1, tx_hash = $2, updated_at = NOW() WHERE id = $3',
            [JobStatus.COMPLETED, result.txHash, txId]
          );
          
          return res.status(200).json({
            success: true,
            txId,
            txHash: result.txHash,
            status: JobStatus.COMPLETED,
            message: 'Transaction completed successfully'
          });
        } else {
          // Job failed
          await pool.query(
            'UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $3',
            [JobStatus.FAILED, txId]
          );
          
          return res.status(400).json({
            success: false,
            txId,
            status: JobStatus.FAILED,
            error: result?.error || 'Transaction failed',
            errorDetails: result?.errorDetails
          });
        }
      } catch (timeoutError) {
        // Job is taking too long, return accepted status
        return res.status(202).json({
          success: true,
          txId,
          jobId: job.id,
          status: JobStatus.PENDING,
          message: 'Transaction is being processed. Check status at /trade/' + txId
        });
      }
    }
  } catch (error: any) {
    console.error('Error in /trade endpoint:', error);
    res.status(500).json({ success: false, error: 'Internal server error: ' + (error.message || 'Unknown error') });
  }
});

// Endpoint to get transaction status
app.get('/trade/:txId', async (req, res) => {
  try {
    const { txId } = req.params;
    
    // Get transaction from database
    const result = await pool.query(
      'SELECT status, tx_hash, created_at, updated_at FROM transactions WHERE id = $1',
      [txId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }
    
    const transaction = result.rows[0];
    
    res.json({
      success: true,
      transaction: {
        txId,
        status: transaction.status,
        txHash: transaction.tx_hash,
        createdAt: transaction.created_at,
        updatedAt: transaction.updated_at
      }
    });
  } catch (error: any) {
    console.error('Error fetching transaction:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error: ' + (error.message || 'Unknown error')
    });
  }
});

// Monitor queue status
app.get('/monitor', async (req, res) => {
  try {
    const metrics = await getQueueMetrics();
    res.json({
      success: true,
      metrics
    });
  } catch (error) {
    console.error('Error getting queue metrics:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get queue metrics' 
    });
  }
});

app.get('/trade/:txId', async (req, res) => {
  try {
    const { txId } = req.params;
    
    const result = await pool.query(
      'SELECT status, tx_hash, created_at, updated_at FROM transactions WHERE id = $1',
      [txId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      transaction: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching transaction:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API server running on port ${PORT}`);

  // Check if DB and Redis are available
  try {
    await pool.query('SELECT 1');
    console.log('Database connection established');
  } catch (error) {
    console.error('Error connecting to database:', error);
    process.exit(1);
  }

  try {
    await tradeQueue.getJobCounts();
    console.log('Redis connection established');
  } catch (error) {
    console.error('Error connecting to Redis:', error);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  try {
    console.log('Closing response worker...');
    await responseWorker.close();
    
    console.log('Closing queue events...');
    await queueEvents.close();
    
    console.log('Closing Redis connection...');
    await connection.quit();
    
    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  try {
    console.log('Closing response worker...');
    await responseWorker.close();
    
    console.log('Closing queue events...');
    await queueEvents.close();
    
    console.log('Closing Redis connection...');
    await connection.quit();
    
    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
});

// Error handling for uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
