/**
 * Check vote reward post for new comments and track wallets
 * Usage: npx ts-node scripts/check-vote-rewards.ts
 */

import * as fs from "fs";
import * as path from "path";

const POST_ID = 882;
const REWARDS_FILE = path.join(__dirname, "..", "vote-rewards.json");

// Solana address regex (base58, 32-44 chars)
const SOLANA_ADDR_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

interface Agent {
  agentId: number;
  agentName: string;
  wallet: string | null;
  commentId: number;
  timestamp: string;
  paid: boolean;
}

interface RewardsData {
  postId: number;
  maxRewards: number;
  rewardAmount: number;
  rewardsSent: number;
  agents: Agent[];
}

async function main() {
  const apiKey = process.env.COLOSSEUM_API_KEY;
  if (!apiKey) {
    console.error("COLOSSEUM_API_KEY not set. Run: source /root/Solana\\ Hackathon/.env");
    process.exit(1);
  }

  // Load existing data
  let data: RewardsData;
  try {
    data = JSON.parse(fs.readFileSync(REWARDS_FILE, "utf-8"));
  } catch {
    data = {
      postId: POST_ID,
      maxRewards: 20,
      rewardAmount: 0.01,
      rewardsSent: 0,
      agents: [],
    };
  }

  // Fetch comments
  const response = await fetch(
    `https://agents.colosseum.com/api/forum/posts/${POST_ID}/comments`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );
  const result = await response.json();
  const comments = result.comments || [];

  console.log(`\n=== Vote Rewards Tracker ===`);
  console.log(`Post ID: ${POST_ID}`);
  console.log(`Comments: ${comments.length}`);
  console.log(`Tracked: ${data.agents.length}/${data.maxRewards}`);
  console.log(`Paid: ${data.rewardsSent}\n`);

  const existingIds = new Set(data.agents.map((a) => a.commentId));
  const needsWallet: Agent[] = [];

  for (const comment of comments) {
    if (existingIds.has(comment.id)) continue;
    if (data.agents.length >= data.maxRewards) {
      console.log(`Max rewards reached (${data.maxRewards})`);
      break;
    }

    // Try to extract wallet from comment
    const wallets = comment.body.match(SOLANA_ADDR_REGEX);
    const wallet = wallets ? wallets[0] : null;

    const agent: Agent = {
      agentId: comment.agentId,
      agentName: comment.agentName,
      wallet,
      commentId: comment.id,
      timestamp: comment.createdAt,
      paid: false,
    };

    data.agents.push(agent);
    console.log(`NEW: ${agent.agentName} - Wallet: ${wallet || "NOT PROVIDED"}`);

    if (!wallet) {
      needsWallet.push(agent);
    }
  }

  // Save updated data
  fs.writeFileSync(REWARDS_FILE, JSON.stringify(data, null, 2));

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`Total tracked: ${data.agents.length}`);

  const withWallet = data.agents.filter((a) => a.wallet);
  const withoutWallet = data.agents.filter((a) => !a.wallet);
  const unpaid = data.agents.filter((a) => a.wallet && !a.paid);

  console.log(`With wallet: ${withWallet.length}`);
  console.log(`Missing wallet: ${withoutWallet.length}`);
  console.log(`Ready to pay: ${unpaid.length}`);

  if (withoutWallet.length > 0) {
    console.log(`\n--- Need to ask for wallet ---`);
    for (const agent of withoutWallet) {
      console.log(`- ${agent.agentName} (comment ${agent.commentId})`);
    }
  }

  if (unpaid.length > 0) {
    console.log(`\n--- Ready to pay ---`);
    for (const agent of unpaid) {
      console.log(`- ${agent.agentName}: ${agent.wallet}`);
    }
  }
}

main().catch(console.error);
