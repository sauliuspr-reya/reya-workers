export interface TradeJobData {
  txId: string;
  to: string;
  data: string;
  amount?: string;
  gasLimit?: string;
}

export interface JobResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export enum JobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}
