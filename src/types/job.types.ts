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
  errorDetails?: Record<string, any>;
}

export enum JobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

export enum ResponseType {
  SIMULATION = 'simulation',
  SUBMISSION = 'submission',
  RECEIPT = 'receipt',
  ERROR = 'error'
}

export interface TradeResponseData {
  txId: string;
  type: ResponseType;
  status: JobStatus;
  timestamp: string;
  txHash?: string;
  // For simulation response
  simulation?: {
    estimatedGas: number;
    expectedOutput: string;
    priceImpact: string;
    route?: string[];
  };
  // For receipt response
  receipt?: {
    blockHash: string;
    blockNumber: number;
    transactionIndex: number;
    gasUsed: number;
    status: boolean;
    logs: any[];
  };
  // For error response
  error?: string;
  errorDetails?: {
    code?: string;
    transaction?: string;
    info?: any;
    shortMessage?: string;
  };
}
