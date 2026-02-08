/**
 * MoltLaunch Verification Gate for Agent Casino
 * 
 * Middleware that gates access to high-roller tables based on MoltLaunch verification.
 * Verified agents get access to higher betting limits and exclusive games.
 */

import { Request, Response, NextFunction } from 'express';

// MoltLaunch API configuration
const MOLTLAUNCH_API = process.env.MOLTLAUNCH_API || 'https://web-production-419d9.up.railway.app';
const MIN_VERIFICATION_SCORE = parseInt(process.env.MIN_VERIFICATION_SCORE || '70');
const VERIFICATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Simple in-memory cache
const verificationCache = new Map<string, { verified: boolean; score: number; tier: string; expires: number }>();

/**
 * Verify an agent with MoltLaunch
 */
async function verifyAgent(agentId: string): Promise<{ verified: boolean; score: number; tier: string }> {
    // Check cache first
    const cached = verificationCache.get(agentId);
    if (cached && cached.expires > Date.now()) {
        return { verified: cached.verified, score: cached.score, tier: cached.tier };
    }

    try {
        const response = await fetch(`${MOLTLAUNCH_API}/api/verify/status/${agentId}`);
        
        if (!response.ok) {
            // Not verified or not found
            return { verified: false, score: 0, tier: 'unknown' };
        }

        const data = await response.json();
        const result = {
            verified: data.verified === true && (data.score || 0) >= MIN_VERIFICATION_SCORE,
            score: data.score || 0,
            tier: data.tier || 'unknown'
        };

        // Cache the result
        verificationCache.set(agentId, {
            ...result,
            expires: Date.now() + VERIFICATION_CACHE_TTL
        });

        return result;
    } catch (e) {
        console.error('MoltLaunch verification error:', e);
        return { verified: false, score: 0, tier: 'error' };
    }
}

/**
 * Get high-roller betting limits based on verification score
 */
function getHighRollerLimits(score: number): { minBet: number; maxBet: number; multiplier: number } {
    if (score >= 90) {
        return { minBet: 0.1, maxBet: 10, multiplier: 1.99 }; // Premium tier
    } else if (score >= 80) {
        return { minBet: 0.05, maxBet: 5, multiplier: 1.98 }; // Gold tier
    } else if (score >= 70) {
        return { minBet: 0.01, maxBet: 2, multiplier: 1.97 }; // Silver tier
    } else {
        return { minBet: 0, maxBet: 0, multiplier: 0 }; // Not eligible
    }
}

/**
 * Express middleware to require MoltLaunch verification
 */
export function requireMoltLaunchVerification(minScore: number = MIN_VERIFICATION_SCORE) {
    return async (req: Request, res: Response, next: NextFunction) => {
        // Get agent ID from header or query
        const agentId = req.headers['x-agent-id'] as string || req.query.agentId as string;

        if (!agentId) {
            return res.status(400).json({
                error: 'Agent ID required',
                hint: 'Pass X-Agent-Id header or agentId query parameter',
                verificationRequired: true,
                verificationUrl: `${MOLTLAUNCH_API}/api/verify/deep`
            });
        }

        const { verified, score, tier } = await verifyAgent(agentId);

        if (!verified) {
            return res.status(403).json({
                error: 'MoltLaunch verification required',
                agentId,
                currentScore: score,
                requiredScore: minScore,
                verified: false,
                verificationUrl: `${MOLTLAUNCH_API}/api/verify/deep`,
                hint: `Get verified at MoltLaunch to access high-roller tables. Score ${minScore}+ required.`
            });
        }

        // Attach verification info to request
        (req as any).moltlaunch = {
            agentId,
            verified: true,
            score,
            tier,
            limits: getHighRollerLimits(score)
        };

        next();
    };
}

/**
 * Get verification status endpoint handler
 */
export async function getVerificationStatus(req: Request, res: Response) {
    const agentId = req.headers['x-agent-id'] as string || req.query.agentId as string || req.params.agentId;

    if (!agentId) {
        return res.status(400).json({ error: 'agentId required' });
    }

    const { verified, score, tier } = await verifyAgent(agentId);
    const limits = getHighRollerLimits(score);

    res.json({
        agentId,
        verified,
        score,
        tier,
        highRollerAccess: verified && score >= MIN_VERIFICATION_SCORE,
        limits: verified ? limits : null,
        verificationUrl: `${MOLTLAUNCH_API}/api/verify/status/${agentId}`,
        verifyNow: verified ? null : `${MOLTLAUNCH_API}/api/verify/deep`
    });
}

/**
 * Verification info endpoint
 */
export function getMoltLaunchInfo(_req: Request, res: Response) {
    res.json({
        enabled: true,
        provider: 'MoltLaunch',
        apiUrl: MOLTLAUNCH_API,
        minScore: MIN_VERIFICATION_SCORE,
        benefits: {
            accessTo: 'High-roller dice tables with better limits',
            scoreTiers: {
                'silver (70-79)': { minBet: 0.01, maxBet: 2, multiplier: 1.97 },
                'gold (80-89)': { minBet: 0.05, maxBet: 5, multiplier: 1.98 },
                'premium (90+)': { minBet: 0.1, maxBet: 10, multiplier: 1.99 }
            }
        },
        howToVerify: [
            '1. POST to https://web-production-419d9.up.railway.app/api/verify/deep',
            '2. Include agentId, capabilities, and codeUrl',
            '3. Score 70+ to unlock high-roller access',
            '4. Pass X-Agent-Id header when playing'
        ]
    });
}

export { verifyAgent, getHighRollerLimits };
