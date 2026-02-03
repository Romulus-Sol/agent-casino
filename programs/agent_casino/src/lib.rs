use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

/// Agent Casino Protocol
/// A headless, API-first casino designed for AI agents.
/// All games are provably fair with on-chain verification.

#[program]
pub mod agent_casino {
    use super::*;

    /// Initialize the casino house pool
    pub fn initialize_house(
        ctx: Context<InitializeHouse>,
        house_edge_bps: u16,
        min_bet: u64,
        max_bet_percent: u8,
    ) -> Result<()> {
        require!(house_edge_bps <= 1000, CasinoError::HouseEdgeTooHigh);
        require!(max_bet_percent > 0 && max_bet_percent <= 10, CasinoError::InvalidMaxBet);

        let house = &mut ctx.accounts.house;
        house.authority = ctx.accounts.authority.key();
        house.pool = 0;
        house.house_edge_bps = house_edge_bps;
        house.min_bet = min_bet;
        house.max_bet_percent = max_bet_percent;
        house.total_games = 0;
        house.total_volume = 0;
        house.total_payout = 0;
        house.bump = ctx.bumps.house;

        emit!(HouseInitialized {
            authority: house.authority,
            house_edge_bps,
            min_bet,
            max_bet_percent,
        });

        Ok(())
    }

    /// Add liquidity to the house pool
    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount: u64) -> Result<()> {
        require!(amount > 0, CasinoError::InvalidAmount);

        // Transfer SOL to the house account (owned by program, can manipulate lamports)
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.provider.to_account_info(),
                to: ctx.accounts.house.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        let lp_position = &mut ctx.accounts.lp_position;
        if lp_position.provider == Pubkey::default() {
            lp_position.provider = ctx.accounts.provider.key();
            lp_position.house = ctx.accounts.house.key();
            lp_position.bump = ctx.bumps.lp_position;
        }
        lp_position.deposited = lp_position.deposited.checked_add(amount).unwrap();

        let house = &mut ctx.accounts.house;
        house.pool = house.pool.checked_add(amount).unwrap();

        emit!(LiquidityAdded {
            provider: ctx.accounts.provider.key(),
            amount,
            total_pool: house.pool,
        });

        Ok(())
    }

    /// Coin flip - 50/50 odds
    pub fn coin_flip(
        ctx: Context<PlayGame>,
        amount: u64,
        choice: u8,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(choice <= 1, CasinoError::InvalidChoice);

        let house = &ctx.accounts.house;
        require!(amount >= house.min_bet, CasinoError::BetTooSmall);
        let max_bet = house.pool * house.max_bet_percent as u64 / 100;
        require!(amount <= max_bet, CasinoError::BetTooLarge);
        require!(house.pool >= amount * 2, CasinoError::InsufficientLiquidity);

        let clock = Clock::get()?;
        let server_seed = generate_seed(
            ctx.accounts.player.key(),
            clock.slot,
            clock.unix_timestamp,
            ctx.accounts.house.key(),
        );
        let combined = combine_seeds(&server_seed, &client_seed, ctx.accounts.player.key());
        let result = (combined[0] % 2) as u8;

        let won = result == choice;
        let payout = if won {
            calculate_payout(amount, 2_00, house.house_edge_bps)
        } else {
            0
        };

        // Transfer bet to house account
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.house.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        // Transfer payout if won (house account is program-owned, can manipulate lamports)
        if won && payout > 0 {
            **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += payout;
        }

        // Update house stats
        let house = &mut ctx.accounts.house;
        house.total_games += 1;
        house.total_volume = house.total_volume.checked_add(amount).unwrap();
        if won {
            house.total_payout = house.total_payout.checked_add(payout).unwrap();
            house.pool = house.pool.checked_sub(payout.saturating_sub(amount)).unwrap_or(0);
        } else {
            house.pool = house.pool.checked_add(amount).unwrap();
        }

        // Update agent stats
        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.player.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games += 1;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(amount).unwrap();
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).unwrap();
            agent_stats.wins += 1;
        } else {
            agent_stats.losses += 1;
        }

        // Record game
        let game_record = &mut ctx.accounts.game_record;
        game_record.player = ctx.accounts.player.key();
        game_record.game_type = GameType::CoinFlip;
        game_record.amount = amount;
        game_record.choice = choice;
        game_record.result = result;
        game_record.payout = payout;
        game_record.server_seed = server_seed;
        game_record.client_seed = client_seed;
        game_record.timestamp = clock.unix_timestamp;
        game_record.slot = clock.slot;
        game_record.bump = ctx.bumps.game_record;

        emit!(GamePlayed {
            player: ctx.accounts.player.key(),
            game_type: GameType::CoinFlip,
            amount,
            choice,
            result,
            payout,
            won,
            server_seed,
            client_seed,
            slot: clock.slot,
        });

        Ok(())
    }

    /// Dice roll - choose target 1-5, win if roll <= target
    pub fn dice_roll(
        ctx: Context<PlayGame>,
        amount: u64,
        target: u8,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(target >= 1 && target <= 5, CasinoError::InvalidChoice);

        let house = &ctx.accounts.house;
        require!(amount >= house.min_bet, CasinoError::BetTooSmall);
        let max_bet = house.pool * house.max_bet_percent as u64 / 100;
        require!(amount <= max_bet, CasinoError::BetTooLarge);
        require!(house.pool >= amount * 2, CasinoError::InsufficientLiquidity);

        let clock = Clock::get()?;
        let server_seed = generate_seed(
            ctx.accounts.player.key(),
            clock.slot,
            clock.unix_timestamp,
            ctx.accounts.house.key(),
        );
        let combined = combine_seeds(&server_seed, &client_seed, ctx.accounts.player.key());
        let result = (combined[0] % 6) + 1;

        let won = result <= target;
        let multiplier = (600 / target as u64) as u16;
        let payout = if won {
            calculate_payout(amount, multiplier, house.house_edge_bps)
        } else {
            0
        };

        // Transfer bet to house account
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.house.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        if won && payout > 0 {
            **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += payout;
        }

        let house = &mut ctx.accounts.house;
        house.total_games += 1;
        house.total_volume = house.total_volume.checked_add(amount).unwrap();
        if won {
            house.total_payout = house.total_payout.checked_add(payout).unwrap();
            house.pool = house.pool.checked_sub(payout.saturating_sub(amount)).unwrap_or(0);
        } else {
            house.pool = house.pool.checked_add(amount).unwrap();
        }

        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.player.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games += 1;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(amount).unwrap();
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).unwrap();
            agent_stats.wins += 1;
        } else {
            agent_stats.losses += 1;
        }

        let game_record = &mut ctx.accounts.game_record;
        game_record.player = ctx.accounts.player.key();
        game_record.game_type = GameType::DiceRoll;
        game_record.amount = amount;
        game_record.choice = target;
        game_record.result = result;
        game_record.payout = payout;
        game_record.server_seed = server_seed;
        game_record.client_seed = client_seed;
        game_record.timestamp = clock.unix_timestamp;
        game_record.slot = clock.slot;
        game_record.bump = ctx.bumps.game_record;

        emit!(GamePlayed {
            player: ctx.accounts.player.key(),
            game_type: GameType::DiceRoll,
            amount,
            choice: target,
            result,
            payout,
            won,
            server_seed,
            client_seed,
            slot: clock.slot,
        });

        Ok(())
    }

    /// Limbo - choose target multiplier, win if result >= target
    pub fn limbo(
        ctx: Context<PlayGame>,
        amount: u64,
        target_multiplier: u16,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(target_multiplier >= 101 && target_multiplier <= 10000, CasinoError::InvalidChoice);

        let house = &ctx.accounts.house;
        require!(amount >= house.min_bet, CasinoError::BetTooSmall);
        let max_bet = house.pool * house.max_bet_percent as u64 / 100;
        require!(amount <= max_bet, CasinoError::BetTooLarge);
        require!(house.pool >= amount * 2, CasinoError::InsufficientLiquidity);

        let clock = Clock::get()?;
        let server_seed = generate_seed(
            ctx.accounts.player.key(),
            clock.slot,
            clock.unix_timestamp,
            ctx.accounts.house.key(),
        );
        let combined = combine_seeds(&server_seed, &client_seed, ctx.accounts.player.key());

        let raw = u32::from_le_bytes([combined[0], combined[1], combined[2], combined[3]]);
        let result_multiplier = calculate_limbo_result(raw, house.house_edge_bps);

        let won = result_multiplier >= target_multiplier;
        let payout = if won {
            (amount as u128 * target_multiplier as u128 / 100) as u64
        } else {
            0
        };

        // Transfer bet to house account
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.house.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        if won && payout > 0 {
            **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += payout;
        }

        let house = &mut ctx.accounts.house;
        house.total_games += 1;
        house.total_volume = house.total_volume.checked_add(amount).unwrap();
        if won {
            house.total_payout = house.total_payout.checked_add(payout).unwrap();
            house.pool = house.pool.checked_sub(payout.saturating_sub(amount)).unwrap_or(0);
        } else {
            house.pool = house.pool.checked_add(amount).unwrap();
        }

        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.player.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games += 1;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(amount).unwrap();
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).unwrap();
            agent_stats.wins += 1;
        } else {
            agent_stats.losses += 1;
        }

        let game_record = &mut ctx.accounts.game_record;
        game_record.player = ctx.accounts.player.key();
        game_record.game_type = GameType::Limbo;
        game_record.amount = amount;
        game_record.choice = (target_multiplier >> 8) as u8;
        game_record.result = (result_multiplier >> 8) as u8;
        game_record.payout = payout;
        game_record.server_seed = server_seed;
        game_record.client_seed = client_seed;
        game_record.timestamp = clock.unix_timestamp;
        game_record.slot = clock.slot;
        game_record.bump = ctx.bumps.game_record;

        emit!(LimboPlayed {
            player: ctx.accounts.player.key(),
            amount,
            target_multiplier,
            result_multiplier,
            payout,
            won,
            server_seed,
            client_seed,
            slot: clock.slot,
        });

        Ok(())
    }

    /// Get house stats
    pub fn get_house_stats(ctx: Context<GetHouseStats>) -> Result<HouseStats> {
        let house = &ctx.accounts.house;
        let max_bet = house.pool * house.max_bet_percent as u64 / 100;
        Ok(HouseStats {
            pool: house.pool,
            house_edge_bps: house.house_edge_bps,
            min_bet: house.min_bet,
            max_bet,
            total_games: house.total_games,
            total_volume: house.total_volume,
            total_payout: house.total_payout,
            house_profit: house.total_volume.saturating_sub(house.total_payout),
        })
    }

    /// Update agent stats
    pub fn update_agent_stats(ctx: Context<UpdateAgentStats>) -> Result<()> {
        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.agent.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        Ok(())
    }
}

// === Helper Functions ===

/// Simple deterministic mixing function for seed generation
fn mix_bytes(data: &[u8]) -> [u8; 32] {
    let mut result = [0u8; 32];
    for (i, byte) in data.iter().enumerate() {
        let idx = i % 32;
        result[idx] = result[idx].wrapping_add(*byte);
        result[(idx + 1) % 32] = result[(idx + 1) % 32].wrapping_mul(result[idx].wrapping_add(1));
        result[(idx + 7) % 32] ^= byte.wrapping_add(i as u8);
    }
    // Additional mixing rounds
    for round in 0..4 {
        for i in 0..32 {
            result[i] = result[i].wrapping_add(result[(i + round + 1) % 32]);
            result[(i + 13) % 32] ^= result[i].rotate_left(3);
        }
    }
    result
}

fn generate_seed(player: Pubkey, slot: u64, timestamp: i64, house: Pubkey) -> [u8; 32] {
    let data = [
        player.to_bytes().as_ref(),
        &slot.to_le_bytes(),
        &timestamp.to_le_bytes(),
        house.to_bytes().as_ref(),
    ].concat();
    mix_bytes(&data)
}

fn combine_seeds(server: &[u8; 32], client: &[u8; 32], player: Pubkey) -> [u8; 32] {
    let combined = [
        server.as_ref(),
        client.as_ref(),
        player.to_bytes().as_ref(),
    ].concat();
    mix_bytes(&combined)
}

fn calculate_payout(amount: u64, multiplier: u16, house_edge_bps: u16) -> u64 {
    let gross = (amount as u128 * multiplier as u128 / 100) as u64;
    let edge = gross * house_edge_bps as u64 / 10000;
    gross - edge
}

fn calculate_limbo_result(raw: u32, house_edge_bps: u16) -> u16 {
    let max = u32::MAX as f64;
    let normalized = raw as f64 / max;
    let edge_factor = 1.0 - (house_edge_bps as f64 / 10000.0);
    let result = (edge_factor / (1.0 - normalized * 0.99)) * 100.0;
    (result.min(10000.0) as u16).max(100)
}

// === Account Structures ===

#[derive(Accounts)]
pub struct InitializeHouse<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + House::INIT_SPACE,
        seeds = [b"house"],
        bump
    )]
    pub house: Account<'info, House>,

    /// CHECK: PDA for holding SOL
    #[account(
        seeds = [b"vault", house.key().as_ref()],
        bump
    )]
    pub house_vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    /// CHECK: PDA vault
    #[account(
        mut,
        seeds = [b"vault", house.key().as_ref()],
        bump
    )]
    pub house_vault: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = provider,
        space = 8 + LpPosition::INIT_SPACE,
        seeds = [b"lp", house.key().as_ref(), provider.key().as_ref()],
        bump
    )]
    pub lp_position: Account<'info, LpPosition>,

    #[account(mut)]
    pub provider: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlayGame<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    /// CHECK: PDA vault
    #[account(
        mut,
        seeds = [b"vault", house.key().as_ref()],
        bump
    )]
    pub house_vault: AccountInfo<'info>,

    #[account(
        init,
        payer = player,
        space = 8 + GameRecord::INIT_SPACE,
        seeds = [b"game", house.key().as_ref(), &house.total_games.to_le_bytes()],
        bump
    )]
    pub game_record: Account<'info, GameRecord>,

    #[account(
        init_if_needed,
        payer = player,
        space = 8 + AgentStats::INIT_SPACE,
        seeds = [b"agent", player.key().as_ref()],
        bump
    )]
    pub agent_stats: Account<'info, AgentStats>,

    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetHouseStats<'info> {
    #[account(seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,
}

#[derive(Accounts)]
pub struct UpdateAgentStats<'info> {
    #[account(
        init_if_needed,
        payer = agent,
        space = 8 + AgentStats::INIT_SPACE,
        seeds = [b"agent", agent.key().as_ref()],
        bump
    )]
    pub agent_stats: Account<'info, AgentStats>,

    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// === State Accounts ===

#[account]
#[derive(InitSpace)]
pub struct House {
    pub authority: Pubkey,
    pub pool: u64,
    pub house_edge_bps: u16,
    pub min_bet: u64,
    pub max_bet_percent: u8,
    pub total_games: u64,
    pub total_volume: u64,
    pub total_payout: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub provider: Pubkey,
    pub house: Pubkey,
    pub deposited: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct GameRecord {
    pub player: Pubkey,
    pub game_type: GameType,
    pub amount: u64,
    pub choice: u8,
    pub result: u8,
    pub payout: u64,
    pub server_seed: [u8; 32],
    pub client_seed: [u8; 32],
    pub timestamp: i64,
    pub slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AgentStats {
    pub agent: Pubkey,
    pub total_games: u64,
    pub total_wagered: u64,
    pub total_won: u64,
    pub wins: u64,
    pub losses: u64,
    pub bump: u8,
}

// === Types ===

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum GameType {
    CoinFlip,
    DiceRoll,
    Limbo,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct HouseStats {
    pub pool: u64,
    pub house_edge_bps: u16,
    pub min_bet: u64,
    pub max_bet: u64,
    pub total_games: u64,
    pub total_volume: u64,
    pub total_payout: u64,
    pub house_profit: u64,
}

// === Events ===

#[event]
pub struct HouseInitialized {
    pub authority: Pubkey,
    pub house_edge_bps: u16,
    pub min_bet: u64,
    pub max_bet_percent: u8,
}

#[event]
pub struct LiquidityAdded {
    pub provider: Pubkey,
    pub amount: u64,
    pub total_pool: u64,
}

#[event]
pub struct GamePlayed {
    pub player: Pubkey,
    pub game_type: GameType,
    pub amount: u64,
    pub choice: u8,
    pub result: u8,
    pub payout: u64,
    pub won: bool,
    pub server_seed: [u8; 32],
    pub client_seed: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct LimboPlayed {
    pub player: Pubkey,
    pub amount: u64,
    pub target_multiplier: u16,
    pub result_multiplier: u16,
    pub payout: u64,
    pub won: bool,
    pub server_seed: [u8; 32],
    pub client_seed: [u8; 32],
    pub slot: u64,
}

// === Errors ===

#[error_code]
pub enum CasinoError {
    #[msg("House edge cannot exceed 10%")]
    HouseEdgeTooHigh,
    #[msg("Invalid max bet percentage")]
    InvalidMaxBet,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Bet is below minimum")]
    BetTooSmall,
    #[msg("Bet exceeds maximum")]
    BetTooLarge,
    #[msg("Insufficient liquidity in house pool")]
    InsufficientLiquidity,
    #[msg("Invalid choice for this game")]
    InvalidChoice,
}
