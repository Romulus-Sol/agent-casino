/**
 * MoltLaunch Verification Gate for Agent Casino
 * 
 * Middleware that gates access to high-roller tables based on MoltLaunch verification.
 * Verified agents get access to higher betting limits and exclusive games.
 * 
 * Security hardening (v1.1):
 * - Input validation for agentId (path traversal prevention)
 * - Fetch timeout (10s) to prevent hanging
 * - Bounded cache (FIFO eviction at 10k entries)
 */

import { Request, Response, NextFunction } from 'express';

// MoltLaunch API configuration
const MOLTLAUNCH_API = process.env.MOLTLAUNCH_API || 'https://web-production-419d9.up.railway.app';
const MIN_VERIFICATION_SCORE = parseInt(process.env.MIN_VERIFICATION_SCORE || '70');
const VERIFICATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000; // 10 seconds
const MAX_CACHE_SIZE = 10_000; // Maximum cache entries

// Input validation regex (alphanumeric, underscore, hyphen, 1-100 chars)
const AGENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,100}$/;

// Simple in-memory cache with bounded size
const verificationCache = new Map<string, { verified: boolean; score: number; tier: string; expires: number }>();

/**
 * Validate agent ID format to prevent path traversal and injection attacks
 */
function isValidAgentId(agentId: string): boolean {
    return AGENT_ID_REGEX.test(agentId);
}

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, { signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Evict oldest entry if cache is at capacity (FIFO)
 */
function evictIfNeeded(): void {
    if (verificationCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = verificationCache.keys().next().value;
        if (oldestKey) {
            verificationCache.delete(oldestKey);
        }
    }
}

/**
 * Verify an agent with MoltLaunch
 */
async function verifyAgent(agentId: string): Promise<{ verified: boolean; score: number; tier: string }> {
    // Validate agentId format first
    if (!isValidAgentId(agentId)) {
        return { verified: false, score: 0, tier: 'invalid' };
    }

    // Check cache first
    const cached = verificationCache.get(agentId);
    if (cached && cached.expires > Date.now()) {
        return { verified: cached.verified, score: cached.score, tier: cached.tier };
    }

    try {
        const response = await fetchWithTimeout(
            `${MOLTLAUNCH_API}/api/verify/status/${encodeURIComponent(agentId)}`
        );
        
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

        // Evict oldest if at capacity, then cache the result
        evictIfNeeded();
        verificationCache.set(agentId, {
            ...result,
            expires: Date.now() + VERIFICATION_CACHE_TTL
        });

        return result;
    } catch (e: any) {
        if (e.name === 'AbortError') {
            console.error('MoltLaunch verification timeout:', agentId);
            return { verified: false, score: 0, tier: 'timeout' };
        }
        console.error('MoltLaunch verification error:', e);
        return { verified: false, score: 0, tier: 'error' };
    }
}

/**
 * Get high-roller betting limits based on verification score
 */
function getHighRollerLimits(score: number): { minBet: number; maxBet: number; multiplier: number; tier: string } {
    if (score >= 90) {
        return { minBet: 0.1, maxBet: 10, multiplier: 1.99, tier: 'premium' }; // Premium tier
    } else if (score >= 80) {
        return { minBet: 0.05, maxBet: 5, multiplier: 1.98, tier: 'gold' }; // Gold tier
    } else if (score >= 70) {
        return { minBet: 0.01, maxBet: 2, multiplier: 1.97, tier: 'silver' }; // Silver tier
    } else {
        return { minBet: 0, maxBet: 0, multiplier: 0, tier: 'none' }; // Not eligible
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

        // Validate agentId format (security: prevent path traversal)
        if (!isValidAgentId(agentId)) {
            return res.status(400).json({
                error: 'Invalid agent ID format',
                hint: 'Agent ID must be 1-100 alphanumeric characters, underscores, or hyphens',
                received: agentId.substring(0, 20) + (agentId.length > 20 ? '...' : '')
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

    // Validate agentId format (security: prevent path traversal)
    if (!isValidAgentId(agentId)) {
        return res.status(400).json({
            error: 'Invalid agent ID format',
            hint: 'Agent ID must be 1-100 alphanumeric characters, underscores, or hyphens'
        });
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
        verificationUrl: `${MOLTLAUNCH_API}/api/verify/status/${encodeURIComponent(agentId)}`,
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
        security: {
            inputValidation: 'Alphanumeric + underscore + hyphen, 1-100 chars',
            fetchTimeout: `${FETCH_TIMEOUT_MS}ms`,
            cacheLimit: MAX_CACHE_SIZE,
            cacheEviction: 'FIFO'
        },
        benefits: {
            accessTo: 'High-roller dice tables with better limits',
            scoreTiers: {
                'silver (70-79)': { minBet: 0.01, maxBet: 2, multiplier: 1.97 },
                'gold (80-89)': { minBet: 0.05, maxBet: 5, multiplier: 1.98 },
                'premium (90+)': { minBet: 0.1, maxBet: 10, multiplier: 1.99 }
            },
            note: 'Actual payouts follow on-chain VRF house edge (1.98x for fair games)'
        },
        howToVerify: [
            '1. POST to https://web-production-419d9.up.railway.app/api/verify/deep',
            '2. Include agentId, capabilities, and codeUrl',
            '3. Score 70+ to unlock high-roller access',
            '4. Pass X-Agent-Id header when playing'
        ]
    });
}

// Export cache stats for monitoring
export function getCacheStats() {
    return {
        size: verificationCache.size,
        maxSize: MAX_CACHE_SIZE,
        utilizationPercent: Math.round((verificationCache.size / MAX_CACHE_SIZE) * 100)
    };
}

export { verifyAgent, getHighRollerLimits, isValidAgentId };
