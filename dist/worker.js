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
dotenv.config();
if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable is not set');
}
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const provider = new ethers_1.ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers_1.ethers.Wallet(PRIVATE_KEY, provider);
const connection = new ioredis_1.default(process.env.REDIS_HOST || 'localhost', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});
const worker = new bullmq_1.Worker('tx-queue', async (job) => {
    const { txId, to, data } = job.data;
    try {
        // Update status to processing
        await (0, db_1.updateTxStatus)(txId, 'PROCESSING');
        // Send transaction
        const tx = await wallet.sendTransaction({
            to,
            data,
        });
        console.log(`Transaction sent: ${tx.hash}`);
        // Wait for confirmation
        await tx.wait();
        // Update status to completed
        await (0, db_1.updateTxStatus)(txId, 'COMPLETED', tx.hash);
        return { success: true, txHash: tx.hash };
    }
    catch (error) {
        console.error(`Error processing transaction ${txId}:`, error);
        await (0, db_1.updateTxStatus)(txId, 'FAILED');
        throw error;
    }
}, {
    connection,
    concurrency: 5,
});
worker.on('completed', job => {
    console.log(`Job ${job.id} completed successfully`);
});
worker.on('failed', (job, error) => {
    console.error(`Job ${job?.id} failed:`, error);
});
