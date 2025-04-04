import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function updateTxStatus(txId: string, status: string, hash?: string) {
  const query = `
    UPDATE transactions 
    SET status = $1, tx_hash = $2, updated_at = NOW() 
    WHERE id = $3
  `;
  
  await pool.query(query, [status, hash || null, txId]);
}
