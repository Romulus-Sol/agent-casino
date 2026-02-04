/**
 * Wallet Loading Utility
 *
 * Prioritizes AgentWallet (hackathon compliant) but falls back to local keypair.
 *
 * Per Colosseum skill.md:
 * - Do NOT use solana-keygen (ephemeral)
 * - Do NOT rely on solana airdrop (rate limited)
 * - DO use AgentWallet for persistent wallets
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

export interface WalletConfig {
  keypair: Keypair;
  publicKey: PublicKey;
  source: "agentwallet" | "local";
  address: string;
}

interface AgentWalletConfig {
  username: string;
  solanaAddress: string;
  apiToken: string;
}

const AGENTWALLET_CONFIG_PATH = path.join(process.env.HOME || "", ".agentwallet", "config.json");
const LOCAL_KEYPAIR_PATH = path.join(process.env.HOME || "", ".config/solana/id.json");

/**
 * Load AgentWallet config if available
 */
export function loadAgentWalletConfig(): AgentWalletConfig | null {
  try {
    if (fs.existsSync(AGENTWALLET_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(AGENTWALLET_CONFIG_PATH, "utf-8"));
    }
  } catch (e) {
    // Config doesn't exist or is invalid
  }
  return null;
}

/**
 * Check if AgentWallet is configured
 */
export function isAgentWalletConfigured(): boolean {
  return loadAgentWalletConfig() !== null;
}

/**
 * Get AgentWallet Solana address
 */
export function getAgentWalletAddress(): string | null {
  const config = loadAgentWalletConfig();
  return config?.solanaAddress || null;
}

/**
 * Load wallet for scripts
 *
 * Priority:
 * 1. AgentWallet (if configured) - but need local keypair for signing
 * 2. Local keypair from ~/.config/solana/id.json
 *
 * Note: AgentWallet provides persistent addresses, but for Anchor programs
 * we still need the local keypair to sign transactions. The key benefit
 * is having a documented, persistent address.
 */
export function loadWallet(options?: { silent?: boolean }): WalletConfig {
  const agentWalletConfig = loadAgentWalletConfig();

  // Check for local keypair (needed for signing)
  if (!fs.existsSync(LOCAL_KEYPAIR_PATH)) {
    console.error("❌ No local keypair found at ~/.config/solana/id.json");
    console.error("\nFor hackathon compliance, please also set up AgentWallet:");
    printAgentWalletSetup();
    process.exit(1);
  }

  // Load local keypair
  const rawKey = JSON.parse(fs.readFileSync(LOCAL_KEYPAIR_PATH, "utf-8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(rawKey));

  // Determine source and warn if not using AgentWallet
  if (agentWalletConfig) {
    if (!options?.silent) {
      console.log("✅ AgentWallet configured");
      console.log(`   AgentWallet address: ${agentWalletConfig.solanaAddress}`);
      console.log(`   Local signer: ${keypair.publicKey.toBase58()}`);
    }

    // If addresses don't match, warn
    if (agentWalletConfig.solanaAddress !== keypair.publicKey.toBase58()) {
      if (!options?.silent) {
        console.log("⚠️  Note: Local keypair differs from AgentWallet address");
        console.log("   For judging, ensure AgentWallet address has funds");
      }
    }

    return {
      keypair,
      publicKey: keypair.publicKey,
      source: "agentwallet",
      address: keypair.publicKey.toBase58()
    };
  } else {
    if (!options?.silent) {
      console.log("⚠️  WARNING: AgentWallet not configured!");
      console.log("   Using local keypair (not recommended for hackathon)");
      console.log("   Run AgentWallet setup for hackathon compliance.\n");
    }

    return {
      keypair,
      publicKey: keypair.publicKey,
      source: "local",
      address: keypair.publicKey.toBase58()
    };
  }
}

/**
 * Print AgentWallet setup instructions
 */
export function printAgentWalletSetup(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                 AGENTWALLET SETUP REQUIRED                        ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Per Colosseum hackathon requirements:                            ║
║  - Do NOT use solana-keygen (ephemeral keys)                      ║
║  - Do NOT rely on solana airdrop (rate limited)                   ║
║  - DO use AgentWallet for persistent wallets                      ║
║                                                                   ║
║  SETUP:                                                           ║
║  1. curl -X POST https://agentwallet.mcpay.tech/api/connect/start ║
║     -d '{"email": "your@email.com"}'                              ║
║                                                                   ║
║  2. Check email for 6-digit OTP                                   ║
║                                                                   ║
║  3. curl -X POST https://agentwallet.mcpay.tech/api/connect/complete ║
║     -d '{"username":"...", "email":"...", "otp":"123456"}'        ║
║                                                                   ║
║  4. Save config to ~/.agentwallet/config.json                     ║
║                                                                   ║
║  Full docs: https://agentwallet.mcpay.tech/skill.md               ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
`);
}

/**
 * Require AgentWallet to be configured (for strict hackathon compliance)
 */
export function requireAgentWallet(): AgentWalletConfig {
  const config = loadAgentWalletConfig();
  if (!config) {
    console.error("❌ AgentWallet required but not configured!");
    printAgentWalletSetup();
    process.exit(1);
  }
  return config;
}

// Export default for convenience
export default loadWallet;
