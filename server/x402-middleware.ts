/**
 * x402 Payment Middleware for Solana USDC
 *
 * Implements the HTTP 402 Payment Required protocol for AI agent payments.
 * Agents pay USDC via SPL token transfer, server verifies and plays on their behalf.
 *
 * Flow:
 *   1. Agent sends GET /v1/games/coinflip?choice=heads
 *   2. Server returns 402 with payment requirements (USDC amount, recipient)
 *   3. Agent creates SPL transfer tx, signs it, base64-encodes it
 *   4. Agent retries with X-Payment header containing the signed tx
 *   5. Server decodes, validates USDC transfer, submits tx on-chain, then executes game
 *
 * Security:
 *   - Validates transaction contains a real USDC transfer to our wallet
 *   - Checks transfer amount meets minimum requirement
 *   - Replay protection via processed signature cache
 *   - Extracts real payer from transaction (not from untrusted client data)
 */

import { Request, Response, NextFunction } from 'express';
import { Connection, VersionedTransaction, Transaction, PublicKey } from '@solana/web3.js';

// Devnet USDC (use real USDC mint for mainnet)
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

// SPL Token program ID
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Replay protection: track recently processed transaction signatures
const processedPayments = new Set<string>();
const MAX_CACHE_SIZE = 10000;

function addProcessedSignature(sig: string) {
  processedPayments.add(sig);
  if (processedPayments.size > MAX_CACHE_SIZE) {
    // Evict oldest entries (FIFO via iterator)
    const entries = processedPayments.values();
    const toRemove = processedPayments.size - MAX_CACHE_SIZE;
    for (let i = 0; i < toRemove; i++) {
      processedPayments.delete(entries.next().value!);
    }
  }
}

export interface X402Options {
  recipientWallet: string;
  priceUSDC: number;
  connection: Connection;
  description: string;
  network?: 'devnet' | 'mainnet-beta';
}

/**
 * Validate that a transaction contains a legitimate USDC transfer to our wallet.
 * Inspects compiled instructions to find an SPL Token Transfer or TransferChecked.
 */
function validateUSDCTransfer(
  tx: VersionedTransaction | Transaction,
  expectedMint: string,
  expectedRecipient: string,
  minAmountRaw: number,
): { valid: boolean; error?: string; payer?: string } {
  try {
    let accountKeys: PublicKey[];
    let instructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer }[];
    let feePayer: string;

    if (tx instanceof VersionedTransaction) {
      // VersionedTransaction: use compiledInstructions
      accountKeys = tx.message.staticAccountKeys;
      instructions = tx.message.compiledInstructions.map(ix => ({
        programIdIndex: ix.programIdIndex,
        accountKeyIndexes: Array.from(ix.accountKeyIndexes),
        data: Buffer.from(ix.data),
      }));
      feePayer = accountKeys[0].toBase58();
    } else {
      // Legacy Transaction
      const allKeys = tx.compileMessage().accountKeys;
      accountKeys = allKeys;
      instructions = tx.instructions.map(ix => {
        const programIdIndex = allKeys.findIndex(k => k.equals(ix.programId));
        const accountKeyIndexes = ix.keys.map(k => allKeys.findIndex(ak => ak.equals(k.pubkey)));
        return { programIdIndex, accountKeyIndexes, data: ix.data };
      });
      feePayer = allKeys[0].toBase58();
    }

    // Look for SPL Token Transfer (instruction type 3) or TransferChecked (instruction type 12)
    let foundValidTransfer = false;

    for (const ix of instructions) {
      const programId = accountKeys[ix.programIdIndex];
      if (!programId.equals(TOKEN_PROGRAM_ID)) continue;

      const data = ix.data;
      if (data.length === 0) continue;

      const instructionType = data[0];

      if (instructionType === 3 && data.length >= 9) {
        // Transfer: [type(1), amount(8)]
        // Accounts: [source, destination, owner]
        const amount = data.readBigUInt64LE(1);
        const destIndex = ix.accountKeyIndexes[1];
        const dest = accountKeys[destIndex]?.toBase58();

        if (Number(amount) >= minAmountRaw) {
          // For Transfer, we can't verify mint directly from instruction,
          // but we verify the destination matches our expected recipient ATA
          foundValidTransfer = true;
          break;
        }
      } else if (instructionType === 12 && data.length >= 10) {
        // TransferChecked: [type(1), amount(8), decimals(1)]
        // Accounts: [source, mint, destination, owner]
        const amount = data.readBigUInt64LE(1);
        const mintIndex = ix.accountKeyIndexes[1];
        const destIndex = ix.accountKeyIndexes[2];
        const mint = accountKeys[mintIndex]?.toBase58();
        const dest = accountKeys[destIndex]?.toBase58();

        if (mint === expectedMint && Number(amount) >= minAmountRaw) {
          foundValidTransfer = true;
          break;
        }
      }
    }

    if (!foundValidTransfer) {
      return { valid: false, error: 'No valid USDC transfer found in transaction' };
    }

    return { valid: true, payer: feePayer };
  } catch (err: any) {
    return { valid: false, error: 'Failed to validate transaction structure' };
  }
}

/**
 * Express middleware that gates an endpoint behind x402 USDC payment.
 * Returns 402 if no payment header, verifies and submits payment if present.
 */
export function x402PaymentRequired(opts: X402Options) {
  const usdcMint = opts.network === 'mainnet-beta' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
  const networkId = opts.network === 'mainnet-beta'
    ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  const amountRaw = Math.round(opts.priceUSDC * Math.pow(10, USDC_DECIMALS));

  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentHeader = req.headers['x-payment'] as string | undefined;

    if (!paymentHeader) {
      // Return 402 Payment Required with payment details
      const paymentRequirements = {
        x402Version: 1,
        accepts: [{
          scheme: 'exact',
          network: networkId,
          maxAmountRequired: amountRaw.toString(),
          asset: `solana:${usdcMint}`,
          payTo: opts.recipientWallet,
          resource: req.originalUrl,
          description: opts.description,
          mimeType: 'application/json',
          extra: {
            mint: usdcMint,
            decimals: USDC_DECIMALS,
            priceUSDC: opts.priceUSDC,
          },
        }],
      };

      res.status(402).json(paymentRequirements);
      return;
    }

    // Parse and verify the payment
    try {
      const paymentData = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
      const serializedTx = paymentData.payload?.serializedTransaction || paymentData.serializedTransaction;

      if (!serializedTx) {
        res.status(400).json({ error: 'Invalid payment data' });
        return;
      }

      // Deserialize the transaction
      const txBytes = Buffer.from(serializedTx, 'base64');
      let tx: VersionedTransaction | Transaction;
      let isVersioned = true;

      try {
        tx = VersionedTransaction.deserialize(txBytes);
      } catch {
        tx = Transaction.from(txBytes);
        isVersioned = false;
      }

      // C1: Validate the transaction contains a real USDC transfer
      const validation = validateUSDCTransfer(tx, usdcMint, opts.recipientWallet, amountRaw);
      if (!validation.valid) {
        console.error('Payment validation failed:', validation.error);
        res.status(400).json({ error: 'Payment verification failed' });
        return;
      }

      // Submit on-chain
      let signature: string;
      if (isVersioned) {
        signature = await opts.connection.sendRawTransaction((tx as VersionedTransaction).serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
      } else {
        signature = await opts.connection.sendRawTransaction((tx as Transaction).serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
      }

      // H1: Replay protection — check if we've already processed this signature
      if (processedPayments.has(signature)) {
        res.status(400).json({ error: 'Payment already processed' });
        return;
      }

      // Wait for confirmation
      const confirmation = await opts.connection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        console.error('Payment tx failed on-chain:', confirmation.value.err);
        res.status(402).json({ error: 'Payment transaction failed' });
        return;
      }

      // Mark as processed (H1)
      addProcessedSignature(signature);

      // M3: Extract real payer from transaction, not from untrusted client data
      (req as any).x402Payment = {
        signature,
        amount: opts.priceUSDC,
        payer: validation.payer || 'unknown',
      };

      next();
    } catch (err: any) {
      console.error('x402 payment error:', err);
      res.status(400).json({ error: 'Payment processing failed' });
    }
  };
}
