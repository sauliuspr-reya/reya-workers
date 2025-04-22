"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const dotenv = __importStar(require("dotenv"));
const queue_1 = require("./queue");
const db_1 = require("./db");
const uuid_1 = require("uuid");
const job_types_1 = require("./types/job.types");
const monitor_1 = require("./monitor");
const sse_utils_1 = require("./utils/sse.utils");
const eth_utils_1 = require("./utils/eth.utils");
dotenv.config();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Set up Redis connection
const redisOptions = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => {
        if (times > 3) {
            console.error(`Redis connection failed after ${times} attempts`);
            return null; // stop retrying
        }
        return Math.min(times * 200, 1000); // exponential backoff
    }
};
console.log('Connecting to Redis at:', redisOptions.host, redisOptions.port);
const connection = new ioredis_1.default(redisOptions);
// Set up queue events for tracking job completions
const queueEvents = new bullmq_1.QueueEvents(queue_1.QUEUE_NAME, { connection });
// Set up response queue worker to process responses from the worker
const responseWorker = new bullmq_1.Worker(queue_1.RESPONSE_QUEUE_NAME, async (job) => {
    const response = job.data;
    console.log(`Received response for txId ${response.txId}: ${response.type}`);
    // Forward the response to the client via SSE
    (0, sse_utils_1.sendSSEUpdate)(response.txId, response);
    // Close the SSE connection if this is the final response (receipt or error)
    if (response.type === job_types_1.ResponseType.RECEIPT || response.type === job_types_1.ResponseType.ERROR) {
        // Give the client a moment to process the final message before closing
        setTimeout(() => (0, sse_utils_1.closeSSEConnection)(response.txId), 500);
    }
}, { connection });
// Handle worker events
responseWorker.on('completed', (job) => {
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
            formattedAmount = (0, eth_utils_1.formatAmount)(amount);
        }
        catch (e) {
            return res.status(400).json({
                success: false,
                error: e.message
            });
        }
        // Create transaction record
        const txId = (0, uuid_1.v4)();
        await db_1.pool.query('INSERT INTO transactions (id, status, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())', [txId, job_types_1.JobStatus.PENDING]);
        console.log('Transaction record created:', txId);
        // Add to queue
        const job = await queue_1.tradeQueue.add('trade', {
            txId,
            to,
            data,
            amount: formattedAmount,
            gasLimit
        });
        console.log('Transaction added to queue:', job.id, 'for txId:', txId);
        if (isSSE) {
            // Register this client to receive SSE updates with disconnect tracking
            (0, sse_utils_1.registerSSEClient)(txId, res, req);
            // Send initial connection message
            const initialMessage = {
                event: 'connected',
                txId,
                status: job_types_1.JobStatus.PENDING,
                timestamp: new Date().toISOString(),
                message: 'Connected to trade stream. Waiting for worker responses...'
            };
            res.write(`data: ${JSON.stringify(initialMessage)}\n\n`);
        }
        else {
            // For regular HTTP clients (like curl), process the request synchronously
            // Add to queue
            const job = await queue_1.tradeQueue.add('trade', {
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
                    await db_1.pool.query('UPDATE transactions SET status = $1, tx_hash = $2, updated_at = NOW() WHERE id = $3', [job_types_1.JobStatus.COMPLETED, result.txHash, txId]);
                    return res.status(200).json({
                        success: true,
                        txId,
                        txHash: result.txHash,
                        status: job_types_1.JobStatus.COMPLETED,
                        message: 'Transaction completed successfully'
                    });
                }
                else {
                    // Job failed
                    await db_1.pool.query('UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $3', [job_types_1.JobStatus.FAILED, txId]);
                    return res.status(400).json({
                        success: false,
                        txId,
                        status: job_types_1.JobStatus.FAILED,
                        error: result?.error || 'Transaction failed',
                        errorDetails: result?.errorDetails
                    });
                }
            }
            catch (timeoutError) {
                // Job is taking too long, return accepted status
                return res.status(202).json({
                    success: true,
                    txId,
                    jobId: job.id,
                    status: job_types_1.JobStatus.PENDING,
                    message: 'Transaction is being processed. Check status at /trade/' + txId
                });
            }
        }
    }
    catch (error) {
        console.error('Error in /trade endpoint:', error);
        res.status(500).json({ success: false, error: 'Internal server error: ' + (error.message || 'Unknown error') });
    }
});
// Endpoint to get transaction status
app.get('/trade/:txId', async (req, res) => {
    try {
        const { txId } = req.params;
        // Get transaction from database
        const result = await db_1.pool.query('SELECT status, tx_hash, created_at, updated_at FROM transactions WHERE id = $1', [txId]);
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
    }
    catch (error) {
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
        const metrics = await (0, monitor_1.getQueueMetrics)();
        res.json({
            success: true,
            metrics
        });
    }
    catch (error) {
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
        const result = await db_1.pool.query('SELECT status, tx_hash, created_at, updated_at FROM transactions WHERE id = $1', [txId]);
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
    }
    catch (error) {
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
        await db_1.pool.query('SELECT 1');
        console.log('Database connection established');
    }
    catch (error) {
        console.error('Error connecting to database:', error);
        process.exit(1);
    }
    try {
        await queue_1.tradeQueue.getJobCounts();
        console.log('Redis connection established');
    }
    catch (error) {
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
    }
    catch (error) {
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
    }
    catch (error) {
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
