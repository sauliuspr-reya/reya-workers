"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const queue_1 = require("./queue");
const db_1 = require("./db");
const uuid_1 = require("uuid");
const job_types_1 = require("./types/job.types");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.post('/trade', async (req, res) => {
    console.log('Trade request received:', req.body);
    try {
        const { to, data, amount, gasLimit } = req.body;
        if (!to || !data) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: to and data are required'
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
            amount,
            gasLimit
        });
        console.log('Transaction added to queue:', txId);
        res.json({
            success: true,
            txId,
            jobId: job.id,
            message: 'Trade submitted successfully'
        });
    }
    catch (error) {
        console.error('Error processing trade:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});
// Get transaction status
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
app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
});
// Graceful shutdown
process.on('SIGTERM', async () => {
    await queue_1.tradeQueue.close();
    process.exit(0);
});
process.on('SIGINT', async () => {
    await queue_1.tradeQueue.close();
    process.exit(0);
});
