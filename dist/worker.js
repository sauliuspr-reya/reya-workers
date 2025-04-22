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
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const ethers_1 = require("ethers");
const dotenv = __importStar(require("dotenv"));
const db_1 = require("./db");
const queue_1 = require("./queue");
const job_types_1 = require("./types/job.types");
dotenv.config();
if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable is not set');
}
if (!process.env.RPC_URL) {
    throw new Error('RPC_URL environment variable is not set');
}
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const provider = new ethers_1.ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers_1.ethers.Wallet(PRIVATE_KEY, provider);
// More detailed connection options for local Redis
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
// Helper function to send response via response queue
async function sendResponse(response) {
    try {
        await queue_1.responseQueue.add('response', response, {
            removeOnComplete: true
        });
        console.log(`Response sent for txId ${response.txId}: ${response.type}`);
    }
    catch (error) {
        console.error(`Error sending response for txId ${response.txId}:`, error);
    }
}
const worker = new bullmq_1.Worker(queue_1.QUEUE_NAME, async (job) => {
    const { txId, to, data, amount, gasLimit } = job.data;
    try {
        // Step 1: Send simulation response
        const simulationResponse = {
            txId,
            type: job_types_1.ResponseType.SIMULATION,
            status: job_types_1.JobStatus.PENDING,
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
        await (0, db_1.updateTxStatus)(txId, job_types_1.JobStatus.PROCESSING);
        // Prepare transaction
        const txParams = {
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
        const submissionResponse = {
            txId,
            type: job_types_1.ResponseType.SUBMISSION,
            status: job_types_1.JobStatus.PROCESSING,
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
        await (0, db_1.updateTxStatus)(txId, job_types_1.JobStatus.COMPLETED, tx.hash);
        // Step 3: Send receipt response
        // Make sure receipt is not null
        if (receipt) {
            const receiptResponse = {
                txId,
                type: job_types_1.ResponseType.RECEIPT,
                status: job_types_1.JobStatus.COMPLETED,
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
    }
    catch (error) {
        console.error(`Error processing transaction ${txId}:`, error);
        await (0, db_1.updateTxStatus)(txId, job_types_1.JobStatus.FAILED);
        // Extract error details for Ethereum errors
        const errorDetails = {};
        if (error.code)
            errorDetails.code = error.code;
        if (error.reason)
            errorDetails.reason = error.reason;
        if (error.transaction)
            errorDetails.transaction = error.transaction;
        if (error.shortMessage)
            errorDetails.shortMessage = error.shortMessage;
        // Include provider error info if available
        if (error.info && error.info.error) {
            errorDetails.info = {
                code: error.info.error.code,
                message: error.info.error.message
            };
        }
        // Send error response
        const errorResponse = {
            txId,
            type: job_types_1.ResponseType.ERROR,
            status: job_types_1.JobStatus.FAILED,
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
}, {
    connection,
    concurrency: 5,
    removeOnComplete: {
        count: 100
    },
    removeOnFail: {
        count: 100
    }
});
// Monitor all worker events
worker.on('active', job => {
    console.log(`Job ${job.id} has started processing`);
});
worker.on('completed', (job, result) => {
    if (result.success) {
        console.log(`Job ${job.id} completed successfully. TX Hash: ${result.txHash}`);
    }
    else {
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
const metricsQueue = new bullmq_1.Queue(queue_1.QUEUE_NAME, { connection });
setInterval(async () => {
    try {
        const jobCounts = await metricsQueue.getJobCounts();
        console.log('Queue metrics:', jobCounts);
    }
    catch (error) {
        console.error('Error getting queue metrics:', error);
    }
}, 30000);
// Graceful shutdown handler for both SIGTERM and SIGINT (Ctrl+C)
async function gracefulShutdown(signal) {
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
        await queue_1.responseQueue.close();
        console.log('Response queue closed successfully');
        console.log('Closing Redis connection...');
        await connection.quit();
        console.log('Redis connection closed successfully');
        console.log('Graceful shutdown completed');
        process.exit(0);
    }
    catch (error) {
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
