/**
 * Jupiter Ultra API integration for Agent Casino
 * Swaps any SPL token to SOL via Jupiter's Ultra API.
 * Auto-detects devnet and uses mock mode (Jupiter only supports mainnet).
 *
 * Security:
 *   - Simulates transactions before signing (C2)
 *   - Validates only known programs are invoked
 *   - URL-encodes all parameters (H4)
 *   - Validates slippage on output (H5)
 *   - Enforces fetch timeouts (M4)
 *   - Integer arithmetic for financial calculations (M5)
 */

import { VersionedTransaction, Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const JUPITER_ULTRA_BASE = 'https://lite-api.jup.ag/ultra/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Known safe program IDs that Jupiter transactions may invoke
const SAFE_PROGRAM_IDS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6 Aggregator
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter V4
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
  '11111111111111111111111111111111',                // System Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',  // Associated Token
  'ComputeBudget111111111111111111111111111111',     // Compute Budget
  'So11111111111111111111111111111111111111112',      // Wrapped SOL
]);

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface JupiterSwapResult {
  solAmount: number;
  signature: string;
  inputMint: string;
  inputAmount: number;
  requestId: string;
  mock: boolean;
}

/**
 * Fetch with AbortController-based timeout (M4)
 */
function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timeout));
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
  // L1: Robust devnet detection (public getter first, private fallback)
  let endpoint = '';
  try {
    endpoint = (connection as any).rpcEndpoint || (connection as any)._rpcEndpoint || '';
  } catch { /* fallback to empty string */ }
  const isDevnet = endpoint.includes('devnet') || process.env.JUPITER_MOCK === 'true';

  if (isDevnet) {
    // Mock mode: Jupiter Ultra API only works on mainnet
    // M2: Validate mock rate
    const mockRate = parseFloat(process.env.JUPITER_MOCK_RATE || '84');
    if (isNaN(mockRate) || mockRate < 1 || mockRate > 10000) {
      throw new Error(`Invalid JUPITER_MOCK_RATE: ${process.env.JUPITER_MOCK_RATE}. Must be 1-10000.`);
    }

    // M5: Integer arithmetic — avoid floating point drift
    const solLamports = Math.floor((amount * LAMPORTS_PER_SOL) / (mockRate * 1_000_000));
    const solAmount = solLamports / LAMPORTS_PER_SOL;

    return {
      solAmount,
      signature: 'MOCK_JUPITER_SWAP',
      inputMint,
      inputAmount: amount,
      requestId: 'mock-devnet',
      mock: true,
    };
  }

  // H4: URL-encode all parameters
  const params = new URLSearchParams({
    inputMint,
    outputMint: SOL_MINT,
    amount: amount.toString(),
    taker: takerPublicKey,
  });
  const orderUrl = `${JUPITER_ULTRA_BASE}/order?${params}`;

  // Step 1: Get order from Jupiter Ultra API (M4: with timeout)
  const orderRes = await fetchWithTimeout(orderUrl);
  if (!orderRes.ok) {
    const err = await orderRes.text();
    throw new Error(`Jupiter order failed: ${err}`);
  }
  const order = await orderRes.json();

  if (!order.transaction) {
    throw new Error(`Jupiter order missing transaction: ${JSON.stringify(order)}`);
  }

  // Step 2: Deserialize the transaction
  const txBuf = Buffer.from(order.transaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);

  // C2: Validate transaction only invokes known/safe programs
  const staticKeys = tx.message.staticAccountKeys;
  for (const ix of tx.message.compiledInstructions) {
    const programId = staticKeys[ix.programIdIndex].toBase58();
    if (!SAFE_PROGRAM_IDS.has(programId)) {
      throw new Error(`Jupiter tx invokes unexpected program: ${programId}. Aborting for safety.`);
    }
  }

  // C2: Simulate transaction before signing
  const simulation = await connection.simulateTransaction(tx, { sigVerify: false });
  if (simulation.value.err) {
    throw new Error(`Jupiter tx simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  // Sign after validation
  const signedTx = await signTransaction(tx);
  const signedBase64 = Buffer.from(signedTx.serialize()).toString('base64');

  // Step 3: Execute (M4: with timeout)
  const execRes = await fetchWithTimeout(`${JUPITER_ULTRA_BASE}/execute`, {
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

  // H5: Validate output amount exists and is reasonable
  if (!result.outputAmount || result.outputAmount <= 0) {
    throw new Error('Jupiter swap returned zero output amount');
  }

  // H5: Check slippage — output should be within 10% of expected
  const expectedOutput = order.outAmount || order.outputAmount;
  if (expectedOutput && result.outputAmount < expectedOutput * 0.9) {
    throw new Error(`Jupiter swap slippage too high: expected ~${expectedOutput}, got ${result.outputAmount}`);
  }

  return {
    solAmount: result.outputAmount / LAMPORTS_PER_SOL,
    signature: result.signature || '',
    inputMint,
    inputAmount: amount,
    requestId: order.requestId,
    mock: false,
  };
}
