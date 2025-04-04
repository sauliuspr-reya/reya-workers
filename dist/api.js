"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const queue_1 = require("./queue");
const db_1 = require("./db");
const uuid_1 = require("uuid");
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.post('/trade', async (req, res) => {
    console.log('Trade request received:', req.body);
    try {
        const { to, data } = req.body;
        if (!to || !data) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        // Create transaction record
        const txId = (0, uuid_1.v4)();
        await db_1.pool.query('INSERT INTO transactions (id, status, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())', [txId, 'PENDING']);
        console.log('Transaction record created:', txId);
        // Add to queue
        await queue_1.txQueue.add('sendTx', {
            txId,
            to,
            data,
        });
        console.log('Transaction added to queue:', txId);
        res.json({
            success: true,
            txId,
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
});
