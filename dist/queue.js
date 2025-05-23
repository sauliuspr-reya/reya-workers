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
exports.responseQueueEvents = exports.queueEvents = exports.responseQueue = exports.tradeQueue = exports.RESPONSE_QUEUE_NAME = exports.QUEUE_NAME = void 0;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const dotenv = __importStar(require("dotenv"));
dotenv.config();
exports.QUEUE_NAME = 'trade-queue';
exports.RESPONSE_QUEUE_NAME = 'trade-response-queue';
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
exports.tradeQueue = new bullmq_1.Queue(exports.QUEUE_NAME, {
    connection,
    defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: 100, // Keep last 100 failed jobs
    },
});
// Response queue for worker to send updates back to API
exports.responseQueue = new bullmq_1.Queue(exports.RESPONSE_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
    },
});
// Queue events for tracking job events
exports.queueEvents = new bullmq_1.QueueEvents(exports.QUEUE_NAME, { connection });
exports.responseQueueEvents = new bullmq_1.QueueEvents(exports.RESPONSE_QUEUE_NAME, { connection });
// Graceful shutdown
process.on('SIGTERM', async () => {
    await exports.tradeQueue.close();
    await exports.responseQueue.close();
});
process.on('SIGINT', async () => {
    await exports.tradeQueue.close();
    await exports.responseQueue.close();
});
