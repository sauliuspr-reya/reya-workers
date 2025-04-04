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
const worker = new bullmq_1.Worker(queue_1.QUEUE_NAME, async (job) => {
    const { txId, to, data, amount, gasLimit } = job.data;
    try {
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
        // Wait for confirmation
        const receipt = await tx.wait();
        if (receipt?.status === 0) {
            throw new Error('Transaction failed');
        }
        // Update status to completed
        await (0, db_1.updateTxStatus)(txId, job_types_1.JobStatus.COMPLETED, tx.hash);
        return {
            success: true,
            txHash: tx.hash
        };
    }
    catch (error) {
        console.error(`Error processing transaction ${txId}:`, error);
        await (0, db_1.updateTxStatus)(txId, job_types_1.JobStatus.FAILED);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
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
