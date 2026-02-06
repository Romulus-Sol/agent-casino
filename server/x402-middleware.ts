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
 *   5. Server decodes, submits tx on-chain, confirms, then executes game
 */

import { Request, Response, NextFunction } from 'express';
import { Connection, VersionedTransaction, Transaction } from '@solana/web3.js';

// Devnet USDC (use real USDC mint for mainnet)
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

export interface X402Options {
  recipientWallet: string;
  priceUSDC: number;
  connection: Connection;
  description: string;
  network?: 'devnet' | 'mainnet-beta';
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
        res.status(400).json({ error: 'Missing serializedTransaction in payment payload' });
        return;
      }

      // Deserialize the transaction
      const txBytes = Buffer.from(serializedTx, 'base64');
      let signature: string;

      try {
        // Try as VersionedTransaction first
        const vtx = VersionedTransaction.deserialize(txBytes);
        signature = await opts.connection.sendRawTransaction(vtx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
      } catch {
        // Fallback to legacy Transaction
        const ltx = Transaction.from(txBytes);
        signature = await opts.connection.sendRawTransaction(ltx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
      }

      // Wait for confirmation
      const confirmation = await opts.connection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        res.status(402).json({
          error: 'Payment transaction failed on-chain',
          details: confirmation.value.err,
        });
        return;
      }

      // Payment verified — attach info to request and proceed
      (req as any).x402Payment = {
        signature,
        amount: opts.priceUSDC,
        payer: paymentData.payload?.payer || 'unknown',
      };

      next();
    } catch (err: any) {
      res.status(400).json({
        error: 'Invalid payment',
        details: err.message,
      });
    }
  };
}
