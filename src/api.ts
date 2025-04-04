import express from 'express';
import { tradeQueue } from './queue';
import { pool } from './db';
import { v4 as uuidv4 } from 'uuid';
import { JobStatus } from './types/job.types';

const app = express();
app.use(express.json());

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
  } catch (error) {
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
app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await tradeQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await tradeQueue.close();
  process.exit(0);
});
