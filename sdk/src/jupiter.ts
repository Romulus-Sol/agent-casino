/**
 * Jupiter Ultra API integration for Agent Casino
 * Swaps any SPL token to SOL via Jupiter's Ultra API.
 * Auto-detects devnet and uses mock mode (Jupiter only supports mainnet).
 */

import { VersionedTransaction, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';

const JUPITER_ULTRA_BASE = 'https://lite-api.jup.ag/ultra/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterSwapResult {
  solAmount: number;
  signature: string;
  inputMint: string;
  inputAmount: number;
  requestId: string;
  mock: boolean;
}

/**
 * Swap any SPL token to SOL via Jupiter Ultra API.
 * On devnet, returns a mock result (Jupiter doesn't support devnet).
 */
export async function jupiterSwapToSol(
  inputMint: string,
  amount: number,
  takerPublicKey: string,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  connection: Connection,
): Promise<JupiterSwapResult> {
  // Auto-detect devnet
  const endpoint = (connection as any)._rpcEndpoint || '';
  const isDevnet = endpoint.includes('devnet') || process.env.JUPITER_MOCK === 'true';

  if (isDevnet) {
    // Mock mode: Jupiter Ultra API only works on mainnet
    // Use configurable rate, default 84 USDC per SOL (6 decimal tokens)
    const mockRate = parseFloat(process.env.JUPITER_MOCK_RATE || '84');
    const solAmount = (amount / Math.pow(10, 6)) / mockRate;
    return {
      solAmount: Math.round(solAmount * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL,
      signature: 'MOCK_JUPITER_SWAP',
      inputMint,
      inputAmount: amount,
      requestId: 'mock-devnet',
      mock: true,
    };
  }

  // Step 1: Get order from Jupiter Ultra API
  const orderUrl = `${JUPITER_ULTRA_BASE}/order?inputMint=${inputMint}&outputMint=${SOL_MINT}&amount=${amount}&taker=${takerPublicKey}`;
  const orderRes = await fetch(orderUrl);
  if (!orderRes.ok) {
    const err = await orderRes.text();
    throw new Error(`Jupiter order failed: ${err}`);
  }
  const order = await orderRes.json();

  if (!order.transaction) {
    throw new Error(`Jupiter order missing transaction: ${JSON.stringify(order)}`);
  }

  // Step 2: Deserialize and sign
  const txBuf = Buffer.from(order.transaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  const signedTx = await signTransaction(tx);
  const signedBase64 = Buffer.from(signedTx.serialize()).toString('base64');

  // Step 3: Execute
  const execRes = await fetch(`${JUPITER_ULTRA_BASE}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTransaction: signedBase64,
      requestId: order.requestId,
    }),
  });

  if (!execRes.ok) {
    const err = await execRes.text();
    throw new Error(`Jupiter execute failed: ${err}`);
  }

  const result = await execRes.json();

  if (result.status !== 'Success') {
    throw new Error(`Jupiter swap failed: ${result.error || JSON.stringify(result)}`);
  }

  return {
    solAmount: (result.outputAmount || 0) / LAMPORTS_PER_SOL,
    signature: result.signature || '',
    inputMint,
    inputAmount: amount,
    requestId: order.requestId,
    mock: false,
  };
}
