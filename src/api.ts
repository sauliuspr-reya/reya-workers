import express from 'express';
import { txQueue } from './queue';
import { pool } from './db';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

app.post('/trade', async (req, res) => {
  console.log('Trade request received:', req.body);
  try {
    const { to, data } = req.body;
    
    if (!to || !data) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Create transaction record
    const txId = uuidv4();
    await pool.query(
      'INSERT INTO transactions (id, status, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())',
      [txId, 'PENDING']
    );
    console.log('Transaction record created:', txId);
    // Add to queue
    await txQueue.add('sendTx', {
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
  } catch (error) {
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
