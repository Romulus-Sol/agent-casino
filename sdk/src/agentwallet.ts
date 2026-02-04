/**
 * AgentWallet Integration for Agent Casino
 *
 * Per Colosseum hackathon requirements (skill.md):
 * - Do NOT use solana-keygen (ephemeral keys)
 * - Do NOT rely on solana airdrop (rate limited)
 * - DO use AgentWallet for persistent, recoverable wallets
 *
 * Setup: https://agentwallet.mcpay.tech/skill.md
 */

import * as fs from "fs";
import * as path from "path";

export interface AgentWalletConfig {
  username: string;
  evmAddress: string;
  solanaAddress: string;
  apiToken: string;
}

export interface WalletBalance {
  chain: string;
  asset: string;
  rawValue: string;
  decimals: number;
}

const AGENTWALLET_API = "https://agentwallet.mcpay.tech/api";
const CONFIG_PATH = path.join(process.env.HOME || "~", ".agentwallet", "config.json");

/**
 * Load AgentWallet config from ~/.agentwallet/config.json
 */
export function loadAgentWalletConfig(): AgentWalletConfig | null {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to load AgentWallet config:", e);
  }
  return null;
}

/**
 * Get the AgentWallet Solana address (persistent, not ephemeral)
 */
export function getAgentWalletAddress(): string | null {
  const config = loadAgentWalletConfig();
  return config?.solanaAddress || null;
}

/**
 * Check if AgentWallet is configured
 */
export function isAgentWalletConfigured(): boolean {
  return loadAgentWalletConfig() !== null;
}

/**
 * Get wallet balances from AgentWallet API
 */
export async function getAgentWalletBalances(): Promise<WalletBalance[] | null> {
  const config = loadAgentWalletConfig();
  if (!config) {
    console.error("AgentWallet not configured. Run setup first.");
    return null;
  }

  try {
    const response = await fetch(`${AGENTWALLET_API}/wallets/${config.username}/balances`, {
      headers: {
        "Authorization": `Bearer ${config.apiToken}`
      }
    });
    const data = await response.json();
    return data.solana?.balances || [];
  } catch (e) {
    console.error("Failed to fetch balances:", e);
    return null;
  }
}

/**
 * Transfer SOL using AgentWallet (devnet or mainnet)
 */
export async function transferSolana(
  to: string,
  amountLamports: number,
  network: "devnet" | "mainnet-beta" = "devnet"
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const config = loadAgentWalletConfig();
  if (!config) {
    return { success: false, error: "AgentWallet not configured" };
  }

  try {
    const response = await fetch(
      `${AGENTWALLET_API}/wallets/${config.username}/actions/transfer-solana`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          to,
          amount: amountLamports.toString(),
          asset: "sol",
          network
        })
      }
    );
    const data = await response.json();

    if (data.success) {
      return { success: true, signature: data.signature || data.txHash };
    }
    return { success: false, error: data.error || "Transfer failed" };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Sign a message using AgentWallet
 */
export async function signMessage(message: string): Promise<{ signature?: string; error?: string }> {
  const config = loadAgentWalletConfig();
  if (!config) {
    return { error: "AgentWallet not configured" };
  }

  try {
    const response = await fetch(
      `${AGENTWALLET_API}/wallets/${config.username}/actions/sign-message`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chain: "solana",
          message
        })
      }
    );
    const data = await response.json();
    return { signature: data.signature };
  } catch (e: any) {
    return { error: e.message };
  }
}

/**
 * Print setup instructions for AgentWallet
 */
export function printSetupInstructions(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    AGENTWALLET SETUP REQUIRED                     ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Per Colosseum hackathon requirements, you must use AgentWallet   ║
║  for persistent wallet management.                                ║
║                                                                   ║
║  DO NOT use:                                                      ║
║    - solana-keygen new (ephemeral keys)                          ║
║    - solana airdrop (rate limited)                               ║
║    - Local keypair files in production                           ║
║                                                                   ║
║  SETUP:                                                           ║
║  1. curl -X POST https://agentwallet.mcpay.tech/api/connect/start ║
║     -d '{"email": "your@email.com"}'                             ║
║                                                                   ║
║  2. Check email for 6-digit OTP                                   ║
║                                                                   ║
║  3. curl -X POST https://agentwallet.mcpay.tech/api/connect/complete ║
║     -d '{"username": "...", "email": "...", "otp": "123456"}'    ║
║                                                                   ║
║  4. Save config to ~/.agentwallet/config.json                     ║
║                                                                   ║
║  Full docs: https://agentwallet.mcpay.tech/skill.md              ║
║                                                                   ║
╚══════════════════════════════════════════════════════════════════╝
`);
}

// Export config for direct access if needed
export { CONFIG_PATH, AGENTWALLET_API };
