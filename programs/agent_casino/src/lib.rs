use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, Transfer};
use switchboard_on_demand::RandomnessAccountData;

declare_id!("5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV");

/// Pyth oracle program ID (devnet)
const PYTH_PROGRAM_ID: Pubkey = pubkey!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

/// CPI helpers for cross-program invocation
pub mod cpi_helpers;
pub use cpi_helpers::*;

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
        lp_position.deposited = lp_position.deposited.checked_add(amount).ok_or(CasinoError::MathOverflow)?;

        let house = &mut ctx.accounts.house;
        house.pool = house.pool.checked_add(amount).ok_or(CasinoError::MathOverflow)?;

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
        let max_bet = house.pool.checked_mul(house.max_bet_percent as u64).ok_or(CasinoError::MathOverflow)? / 100;
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
        house.total_games = house.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        house.total_volume = house.total_volume.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            house.total_payout = house.total_payout.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            house.pool = house.pool.checked_sub(payout.saturating_sub(amount)).ok_or(CasinoError::MathOverflow)?;
        } else {
            house.pool = house.pool.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        }

        // Update agent stats
        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.player.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games = agent_stats.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
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
        let max_bet = house.pool.checked_mul(house.max_bet_percent as u64).ok_or(CasinoError::MathOverflow)? / 100;
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
        let result = ((raw % 6) + 1) as u8;

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
        house.total_games = house.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        house.total_volume = house.total_volume.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            house.total_payout = house.total_payout.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            house.pool = house.pool.checked_sub(payout.saturating_sub(amount)).ok_or(CasinoError::MathOverflow)?;
        } else {
            house.pool = house.pool.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        }

        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.player.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games = agent_stats.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
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
        let max_bet = house.pool.checked_mul(house.max_bet_percent as u64).ok_or(CasinoError::MathOverflow)? / 100;
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
        house.total_games = house.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        house.total_volume = house.total_volume.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            house.total_payout = house.total_payout.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            house.pool = house.pool.checked_sub(payout.saturating_sub(amount)).ok_or(CasinoError::MathOverflow)?;
        } else {
            house.pool = house.pool.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        }

        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.player.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games = agent_stats.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
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

    /// Crash game - set a cashout multiplier, win if crash point >= your target
    /// Uses exponential distribution where most games crash early but high multipliers possible
    /// Multiplier range: 1.01x (101) to 100x (10000), represented as integers * 100
    pub fn crash(
        ctx: Context<PlayGame>,
        amount: u64,
        cashout_multiplier: u16,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(cashout_multiplier >= 101 && cashout_multiplier <= 10000, CasinoError::InvalidChoice);

        let house = &ctx.accounts.house;
        require!(amount >= house.min_bet, CasinoError::BetTooSmall);
        let max_bet = house.pool.checked_mul(house.max_bet_percent as u64).ok_or(CasinoError::MathOverflow)? / 100;
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
        let crash_point = calculate_crash_point(raw, house.house_edge_bps);

        // Player wins if the crash point is >= their cashout multiplier
        let won = crash_point >= cashout_multiplier;
        let payout = if won {
            (amount as u128 * cashout_multiplier as u128 / 100) as u64
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
        house.total_games = house.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        house.total_volume = house.total_volume.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            house.total_payout = house.total_payout.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            house.pool = house.pool.checked_sub(payout.saturating_sub(amount)).ok_or(CasinoError::MathOverflow)?;
        } else {
            house.pool = house.pool.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        }

        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.player.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games = agent_stats.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            agent_stats.wins += 1;
        } else {
            agent_stats.losses += 1;
        }

        let game_record = &mut ctx.accounts.game_record;
        game_record.player = ctx.accounts.player.key();
        game_record.game_type = GameType::Crash;
        game_record.amount = amount;
        game_record.choice = (cashout_multiplier >> 8) as u8;
        game_record.result = (crash_point >> 8) as u8;
        game_record.payout = payout;
        game_record.server_seed = server_seed;
        game_record.client_seed = client_seed;
        game_record.timestamp = clock.unix_timestamp;
        game_record.slot = clock.slot;
        game_record.bump = ctx.bumps.game_record;

        emit!(CrashPlayed {
            player: ctx.accounts.player.key(),
            amount,
            cashout_multiplier,
            crash_point,
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
        let max_bet = house.pool.checked_mul(house.max_bet_percent as u64).ok_or(CasinoError::MathOverflow)? / 100;
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

    /// Update/migrate agent stats (handles old-size accounts)
    pub fn update_agent_stats(ctx: Context<UpdateAgentStats>) -> Result<()> {
        let agent_stats_info = ctx.accounts.agent_stats.to_account_info();
        let expected_size = 8 + AgentStats::INIT_SPACE;

        if agent_stats_info.data_len() == 0 {
            // Account doesn't exist yet - nothing to migrate
            return Ok(());
        }

        if agent_stats_info.data_len() != expected_size {
            // Need to realloc - account is wrong size
            let rent = Rent::get()?;
            let new_min_balance = rent.minimum_balance(expected_size);
            let current_lamports = agent_stats_info.lamports();

            if new_min_balance > current_lamports {
                let diff = new_min_balance - current_lamports;
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.agent.to_account_info(),
                            to: agent_stats_info.clone(),
                        },
                    ),
                    diff,
                )?;
            }

            agent_stats_info.realloc(expected_size, false)?;

            // Return excess rent to agent if account shrank
            if current_lamports > new_min_balance {
                let diff = current_lamports - new_min_balance;
                **agent_stats_info.try_borrow_mut_lamports()? -= diff;
                **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += diff;
            }
        }

        Ok(())
    }

    // ==================== PvP CHALLENGES ====================

    /// Create a PvP coin flip challenge
    /// Challenger locks their bet and picks heads (0) or tails (1)
    /// nonce: unique identifier for this challenge (use timestamp or random number)
    pub fn create_challenge(
        ctx: Context<CreateChallenge>,
        amount: u64,
        choice: u8,
        nonce: u64,
    ) -> Result<()> {
        require!(choice <= 1, CasinoError::InvalidChoice);
        require!(amount > 0, CasinoError::InvalidAmount);

        let house = &ctx.accounts.house;
        require!(amount >= house.min_bet, CasinoError::BetTooSmall);

        // Transfer challenger's bet to the challenge account (escrow)
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.challenger.to_account_info(),
                to: ctx.accounts.challenge.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        let clock = Clock::get()?;
        let challenge = &mut ctx.accounts.challenge;
        challenge.challenger = ctx.accounts.challenger.key();
        challenge.amount = amount;
        challenge.choice = choice;
        challenge.status = ChallengeStatus::Open;
        challenge.created_at = clock.unix_timestamp;
        challenge.acceptor = Pubkey::default();
        challenge.winner = Pubkey::default();
        challenge.result = 0;
        challenge.nonce = nonce;
        challenge.bump = ctx.bumps.challenge;

        emit!(ChallengeCreated {
            challenge_id: ctx.accounts.challenge.key(),
            challenger: ctx.accounts.challenger.key(),
            amount,
            choice,
            created_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Accept a PvP challenge - triggers the coin flip
    /// Acceptor automatically takes the opposite side
    pub fn accept_challenge(
        ctx: Context<AcceptChallenge>,
        client_seed: [u8; 32],
    ) -> Result<()> {
        let challenge = &ctx.accounts.challenge;
        require!(challenge.status == ChallengeStatus::Open, CasinoError::ChallengeNotOpen);
        require!(challenge.challenger != ctx.accounts.acceptor.key(), CasinoError::CannotAcceptOwnChallenge);

        let amount = challenge.amount;
        let challenger_choice = challenge.choice;

        // Transfer acceptor's bet to the challenge account
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.acceptor.to_account_info(),
                to: ctx.accounts.challenge.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        // Generate result
        let clock = Clock::get()?;
        let server_seed = generate_seed(
            ctx.accounts.acceptor.key(),
            clock.slot,
            clock.unix_timestamp,
            ctx.accounts.challenge.key(),
        );
        let combined = combine_seeds(&server_seed, &client_seed, ctx.accounts.challenger.key());
        let result = (combined[0] % 2) as u8;

        // Determine winner
        let challenger_won = result == challenger_choice;
        let winner = if challenger_won {
            ctx.accounts.challenger.key()
        } else {
            ctx.accounts.acceptor.key()
        };

        // Calculate payout: total pot minus 1% house edge
        let total_pot = amount.checked_mul(2).ok_or(CasinoError::MathOverflow)?;
        let house_edge = ctx.accounts.house.house_edge_bps;
        let house_take = total_pot.checked_mul(house_edge as u64).ok_or(CasinoError::MathOverflow)? / 10000;
        let winner_payout = total_pot - house_take;

        // Transfer house edge to house account
        if house_take > 0 {
            **ctx.accounts.challenge.to_account_info().try_borrow_mut_lamports()? -= house_take;
            **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? += house_take;
        }

        // Transfer winnings to winner
        let winner_account = if challenger_won {
            ctx.accounts.challenger.to_account_info()
        } else {
            ctx.accounts.acceptor.to_account_info()
        };
        **ctx.accounts.challenge.to_account_info().try_borrow_mut_lamports()? -= winner_payout;
        **winner_account.try_borrow_mut_lamports()? += winner_payout;

        // Update challenge state
        let challenge = &mut ctx.accounts.challenge;
        challenge.status = ChallengeStatus::Completed;
        challenge.acceptor = ctx.accounts.acceptor.key();
        challenge.winner = winner;
        challenge.result = result;
        challenge.server_seed = server_seed;
        challenge.client_seed = client_seed;
        challenge.completed_at = clock.unix_timestamp;

        // Update house stats
        let house = &mut ctx.accounts.house;
        house.total_games = house.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        house.total_volume = house.total_volume.checked_add(total_pot).ok_or(CasinoError::MathOverflow)?;
        house.pool = house.pool.checked_add(house_take).ok_or(CasinoError::MathOverflow)?;

        // Update challenger stats
        let challenger_stats = &mut ctx.accounts.challenger_stats;
        if challenger_stats.agent == Pubkey::default() {
            challenger_stats.agent = ctx.accounts.challenger.key();
        }
        challenger_stats.total_games = challenger_stats.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        challenger_stats.total_wagered = challenger_stats.total_wagered.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        challenger_stats.pvp_games = challenger_stats.pvp_games.checked_add(1).unwrap_or(challenger_stats.pvp_games);
        if challenger_won {
            challenger_stats.total_won = challenger_stats.total_won.checked_add(winner_payout).ok_or(CasinoError::MathOverflow)?;
            challenger_stats.wins += 1;
            challenger_stats.pvp_wins = challenger_stats.pvp_wins.checked_add(1).unwrap_or(challenger_stats.pvp_wins);
        } else {
            challenger_stats.losses += 1;
        }

        // Update acceptor stats
        let acceptor_stats = &mut ctx.accounts.acceptor_stats;
        if acceptor_stats.agent == Pubkey::default() {
            acceptor_stats.agent = ctx.accounts.acceptor.key();
            acceptor_stats.bump = ctx.bumps.acceptor_stats;
        }
        acceptor_stats.total_games = acceptor_stats.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        acceptor_stats.total_wagered = acceptor_stats.total_wagered.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        acceptor_stats.pvp_games = acceptor_stats.pvp_games.checked_add(1).unwrap_or(acceptor_stats.pvp_games);
        if !challenger_won {
            acceptor_stats.total_won = acceptor_stats.total_won.checked_add(winner_payout).ok_or(CasinoError::MathOverflow)?;
            acceptor_stats.wins += 1;
            acceptor_stats.pvp_wins = acceptor_stats.pvp_wins.checked_add(1).unwrap_or(acceptor_stats.pvp_wins);
        } else {
            acceptor_stats.losses += 1;
        }

        emit!(ChallengeAccepted {
            challenge_id: ctx.accounts.challenge.key(),
            challenger: ctx.accounts.challenger.key(),
            acceptor: ctx.accounts.acceptor.key(),
            amount,
            challenger_choice,
            result,
            winner,
            payout: winner_payout,
            house_take,
        });

        Ok(())
    }

    /// Cancel an open challenge and refund the challenger
    pub fn cancel_challenge(ctx: Context<CancelChallenge>) -> Result<()> {
        let challenge = &ctx.accounts.challenge;
        require!(challenge.status == ChallengeStatus::Open, CasinoError::ChallengeNotOpen);
        require!(challenge.challenger == ctx.accounts.challenger.key(), CasinoError::NotChallengeOwner);

        let amount = challenge.amount;

        // Refund challenger
        **ctx.accounts.challenge.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.challenger.to_account_info().try_borrow_mut_lamports()? += amount;

        // Update challenge state
        let challenge = &mut ctx.accounts.challenge;
        challenge.status = ChallengeStatus::Cancelled;

        emit!(ChallengeCancelled {
            challenge_id: ctx.accounts.challenge.key(),
            challenger: ctx.accounts.challenger.key(),
            amount,
        });

        Ok(())
    }

    // ==================== PREDICTION MARKETS ====================
    //
    // PARI-MUTUEL ODDS CALCULATION (responding to ClaudeCraft's question):
    // ====================================================================
    // All bets on an outcome pool together. Winners split the total pool
    // proportionally to their stake, minus house edge.
    //
    // Formula: winnings = (your_bet / winning_pool) * (total_pool * 0.99)
    //
    // Example with 100 SOL total pool, 1% house edge:
    //   - Outcome A pool: 40 SOL (40% implied probability)
    //   - Outcome B pool: 60 SOL (60% implied probability)
    //   - If A wins: A bettors split 99 SOL proportionally
    //   - A bettor with 10 SOL gets: (10/40) * 99 = 24.75 SOL (2.475x return)
    //
    // Odds update dynamically as more bets come in. Early bettors on
    // underdog outcomes get better odds if the pool stays small.
    //
    // COMMIT-REVEAL PATTERN (responding to Sipher's privacy suggestion):
    // ==================================================================
    // Bets are hidden until the reveal phase to prevent:
    //   - Front-running: Can't see and copy others' bets
    //   - Strategy copying: Predictions stay private during betting
    //   - Last-minute manipulation: Can't game odds at deadline
    //
    // Phase 1 (Commit): Submit hash(outcome || salt) + lock funds
    // Phase 2 (Reveal): After betting closes, reveal choice (verified by hash)
    // Phase 3 (Resolve): Authority declares winning outcome
    // Phase 4 (Claim): Winners claim proportional winnings

    /// Create a new OPEN prediction market with commit-reveal betting
    ///
    /// OPEN MARKET DESIGN:
    /// - No fixed outcome list - agents can bet on ANY project
    /// - Bettors specify project slug when revealing (e.g., "clodds", "agent-casino-protocol")
    /// - All correct predictions split the pool proportionally
    ///
    /// question: Short description (e.g., "Which project wins 1st place?")
    /// commit_deadline: Unix timestamp when commit phase ends
    /// reveal_deadline: Unix timestamp when reveal phase ends
    pub fn create_prediction_market(
        ctx: Context<CreatePredictionMarket>,
        market_id: u64,
        question: String,
        commit_deadline: i64,
        reveal_deadline: i64,
    ) -> Result<()> {
        require!(question.len() <= 200, CasinoError::QuestionTooLong);

        let clock = Clock::get()?;
        require!(commit_deadline > clock.unix_timestamp, CasinoError::InvalidCloseTime);
        require!(reveal_deadline > commit_deadline, CasinoError::RevealMustBeAfterCommit);

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.market_id = market_id;

        // Store question as fixed-size array
        let mut question_bytes = [0u8; 200];
        let q_bytes = question.as_bytes();
        question_bytes[..q_bytes.len().min(200)].copy_from_slice(&q_bytes[..q_bytes.len().min(200)]);
        market.question = question_bytes;

        market.status = MarketStatus::Committing;
        market.winning_project = [0u8; 50]; // Empty until resolved
        market.winning_pool = 0;
        market.total_pool = 0;
        market.total_committed = 0;
        market.commit_deadline = commit_deadline;
        market.reveal_deadline = reveal_deadline;
        market.resolved_at = 0;
        market.created_at = clock.unix_timestamp;
        market.bump = ctx.bumps.market;

        emit!(PredictionMarketCreated {
            market_id: ctx.accounts.market.key(),
            authority: ctx.accounts.authority.key(),
            question,
            commit_deadline,
            reveal_deadline,
        });

        Ok(())
    }

    /// COMMIT PHASE: Submit a hidden bet commitment
    /// commitment: hash(outcome_index || salt) - 32 bytes
    /// amount: SOL to lock (bet size is public, choice is hidden)
    ///
    /// Bettors can see pool sizes but NOT which outcomes others picked.
    /// This prevents front-running and strategy copying.
    pub fn commit_prediction_bet(
        ctx: Context<CommitPredictionBet>,
        commitment: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Committing, CasinoError::NotInCommitPhase);
        require!(amount > 0, CasinoError::InvalidAmount);

        let clock = Clock::get()?;
        require!(clock.unix_timestamp < market.commit_deadline, CasinoError::CommitPhaseClosed);

        let house = &ctx.accounts.house;
        require!(amount >= house.min_bet, CasinoError::BetTooSmall);

        // Capture keys before mutable borrows
        let market_key = ctx.accounts.market.key();
        let bettor_key = ctx.accounts.bettor.key();

        // Transfer bet to market account (escrow)
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.bettor.to_account_info(),
                to: ctx.accounts.market.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        // Update market total (but NOT outcome pools - those stay hidden)
        let market = &mut ctx.accounts.market;
        market.total_committed = market.total_committed.checked_add(amount).ok_or(CasinoError::MathOverflow)?;

        // Store commitment with timestamp for early bird bonus
        // Commitment = hash(project_slug || salt) - verified at reveal time
        let bet = &mut ctx.accounts.bet;
        require!(bet.bettor == Pubkey::default(), CasinoError::AlreadyCommitted);
        bet.bettor = bettor_key;
        bet.market = market_key;
        bet.commitment = commitment;
        bet.amount = amount;
        bet.committed_at = clock.unix_timestamp; // For early bird fee rebate
        bet.revealed = false;
        bet.predicted_project = [0u8; 50]; // Unknown until reveal
        bet.claimed = false;
        bet.bump = ctx.bumps.bet;

        emit!(PredictionBetCommitted {
            market_id: market_key,
            bettor: bettor_key,
            commitment,
            amount,
            total_committed: market.total_committed,
        });

        Ok(())
    }

    /// Transition market from Committing to Revealing phase
    /// Anyone can call this after commit_deadline passes
    pub fn start_reveal_phase(ctx: Context<StartRevealPhase>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Committing, CasinoError::NotInCommitPhase);

        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= market.commit_deadline, CasinoError::CommitPhaseNotEnded);

        // Capture key before mutable borrow
        let market_key = ctx.accounts.market.key();

        let market = &mut ctx.accounts.market;
        market.status = MarketStatus::Revealing;
        market.total_pool = market.total_committed; // Lock in total pool

        let total_committed = market.total_committed;

        emit!(RevealPhaseStarted {
            market_id: market_key,
            total_committed,
        });

        Ok(())
    }

    /// REVEAL PHASE: Reveal your committed bet
    /// outcome_index: Your actual pick (0 to outcome_count-1)
    /// salt: Random bytes used in commitment
    ///
    /// Verifies: hash(outcome_index || salt) == stored commitment
    /// Updates outcome pools with revealed bets
    /// Reveal prediction bet with project slug
    ///
    /// OPEN MARKET: Bettors specify which project they're betting on.
    /// Any valid project slug is accepted - no fixed outcome list.
    ///
    /// predicted_project: Project slug (e.g., "clodds", "agent-casino-protocol")
    /// salt: 32-byte salt used in commitment
    pub fn reveal_prediction_bet(
        ctx: Context<RevealPredictionBet>,
        predicted_project: String,
        salt: [u8; 32],
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Revealing, CasinoError::NotInRevealPhase);
        require!(predicted_project.len() > 0 && predicted_project.len() <= 50, CasinoError::InvalidProjectSlug);

        let clock = Clock::get()?;
        require!(clock.unix_timestamp < market.reveal_deadline, CasinoError::RevealPhaseClosed);

        let bet = &ctx.accounts.bet;
        require!(!bet.revealed, CasinoError::AlreadyRevealed);

        // Verify commitment: hash(project_slug || salt) must equal stored commitment
        // Build preimage: project bytes (variable) + salt (32 bytes)
        let project_bytes = predicted_project.as_bytes();
        let mut preimage = Vec::with_capacity(project_bytes.len() + 32);
        preimage.extend_from_slice(project_bytes);
        preimage.extend_from_slice(&salt);
        let computed_hash = mix_bytes(&preimage);
        require!(computed_hash == bet.commitment, CasinoError::InvalidReveal);

        let amount = bet.amount;
        let market_key = ctx.accounts.market.key();
        let bettor_key = ctx.accounts.bettor.key();

        // Mark bet as revealed with predicted project
        let mut project_bytes = [0u8; 50];
        let p_bytes = predicted_project.as_bytes();
        project_bytes[..p_bytes.len().min(50)].copy_from_slice(&p_bytes[..p_bytes.len().min(50)]);

        let bet = &mut ctx.accounts.bet;
        bet.revealed = true;
        bet.predicted_project = project_bytes;

        emit!(PredictionBetRevealed {
            market_id: market_key,
            bettor: bettor_key,
            predicted_project,
            amount,
        });

        Ok(())
    }

    /// Forfeit unrevealed bet (after reveal deadline)
    /// Unrevealed bets go to the house as penalty for not revealing
    pub fn forfeit_unrevealed_bet(ctx: Context<ForfeitUnrevealedBet>) -> Result<()> {
        let market = &ctx.accounts.market;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= market.reveal_deadline, CasinoError::RevealPhaseNotEnded);

        let bet = &ctx.accounts.bet;
        require!(!bet.revealed, CasinoError::AlreadyRevealed);
        require!(!bet.claimed, CasinoError::AlreadyClaimed);

        let forfeit_amount = bet.amount;

        // Transfer forfeited amount to house
        **ctx.accounts.market.to_account_info().try_borrow_mut_lamports()? -= forfeit_amount;
        **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? += forfeit_amount;

        // Update house stats
        let house = &mut ctx.accounts.house;
        house.pool = house.pool.checked_add(forfeit_amount).ok_or(CasinoError::MathOverflow)?;

        // Reduce total pool (forfeit doesn't count toward payouts)
        let market = &mut ctx.accounts.market;
        market.total_pool = market.total_pool.saturating_sub(forfeit_amount);

        // Mark as claimed to prevent double-forfeit
        let bet = &mut ctx.accounts.bet;
        bet.claimed = true;

        emit!(BetForfeited {
            market_id: ctx.accounts.market.key(),
            bettor: bet.bettor,
            amount: forfeit_amount,
        });

        Ok(())
    }

    /// Resolve an OPEN prediction market (authority only)
    ///
    /// OPEN MARKET RESOLUTION:
    /// - Authority provides winning project slug and total winning pool
    /// - winning_pool = sum of all revealed bets on the winning project
    /// - This is verifiable off-chain by summing revealed bets
    ///
    /// winning_project: Slug of winning project (e.g., "clodds")
    /// winning_pool: Total SOL bet on the winning project (calculated off-chain)
    pub fn resolve_prediction_market(
        ctx: Context<ResolvePredictionMarket>,
        winning_project: String,
        winning_pool: u64,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(
            market.status == MarketStatus::Revealing || market.status == MarketStatus::Committing,
            CasinoError::MarketNotOpen
        );
        require!(winning_project.len() > 0 && winning_project.len() <= 50, CasinoError::InvalidProjectSlug);
        require!(
            ctx.accounts.authority.key() == market.authority,
            CasinoError::NotMarketAuthority
        );

        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= market.reveal_deadline, CasinoError::RevealPhaseNotEnded);

        // Capture values before mutable borrow
        let market_key = ctx.accounts.market.key();
        let total_pool = market.total_pool;

        // NOTE: House fee is NOT taken here anymore - it's calculated per-bettor at claim time
        // with early bird discounts. Early bettors get up to 100% fee rebate.
        // See claim_prediction_winnings for the per-bettor fee calculation.

        // Update house stats (volume tracked, fee will be added at claim time)
        let house = &mut ctx.accounts.house;
        house.total_volume = house.total_volume.checked_add(total_pool).ok_or(CasinoError::MathOverflow)?;

        // Calculate what the max house take WOULD be (for event reporting)
        let house_edge = house.house_edge_bps;
        let max_house_take = total_pool.checked_mul(house_edge as u64).ok_or(CasinoError::MathOverflow)? / 10000;

        // Update market state with winning project
        let mut winner_bytes = [0u8; 50];
        let w_bytes = winning_project.as_bytes();
        winner_bytes[..w_bytes.len().min(50)].copy_from_slice(&w_bytes[..w_bytes.len().min(50)]);

        let market = &mut ctx.accounts.market;
        market.status = MarketStatus::Resolved;
        market.winning_project = winner_bytes;
        market.winning_pool = winning_pool;
        market.resolved_at = clock.unix_timestamp;

        emit!(PredictionMarketResolved {
            market_id: market_key,
            winning_project,
            total_pool,
            winning_pool,
            house_take: max_house_take, // Max possible; actual varies by early bird discounts
        });

        Ok(())
    }

    /// Claim winnings from a resolved prediction market
    ///
    /// PARI-MUTUEL PAYOUT CALCULATION WITH EARLY BIRD FEE REBATE:
    ///
    /// Base formula: winnings = (your_bet / winning_pool) * total_pool
    /// Fee formula:  fee = base_fee * (1 - early_bird_factor)
    ///
    /// Early bird factor = time_until_deadline / total_commit_duration
    ///   - Bet at market creation: 100% factor → 0% fee (full rebate)
    ///   - Bet at commit deadline: 0% factor → 1% fee (no rebate)
    ///   - Bet halfway through: 50% factor → 0.5% fee
    ///
    /// Example: You bet 10 SOL on outcome A at market creation (100% early)
    ///   - Total pool: 100 SOL
    ///   - Outcome A pool: 40 SOL (your 10 + others' 30)
    ///   - Your gross share: (10/40) * 100 = 25 SOL
    ///   - Early bird factor: 1.0 (committed immediately)
    ///   - Effective fee: 1% * (1 - 1.0) = 0%
    ///   - Your payout: 25 SOL (no fee!)
    ///   - Your profit: 25 - 10 = 15 SOL (150% return)
    ///
    /// NO WINNER SCENARIO:
    /// If winning_pool == 0 (nobody bet on the winning project), all revealed
    /// bettors can claim a full refund of their original bet. This prevents
    /// funds from being locked forever when no one predicted correctly.
    pub fn claim_prediction_winnings(ctx: Context<ClaimPredictionWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let bet = &ctx.accounts.bet;

        require!(market.status == MarketStatus::Resolved, CasinoError::MarketNotResolved);
        require!(bet.revealed, CasinoError::BetNotRevealed);
        require!(!bet.claimed, CasinoError::AlreadyClaimed);

        let winning_pool = market.winning_pool;
        let market_key = ctx.accounts.market.key();
        let bettor_key = ctx.accounts.bettor.key();
        let bet_amount = bet.amount;

        // NO WINNER SCENARIO: If winning_pool == 0, refund all revealed bettors
        if winning_pool == 0 {
            // Full refund - no fees charged when nobody wins
            let refund_amount = bet_amount;

            // Transfer refund to bettor
            **ctx.accounts.market.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
            **ctx.accounts.bettor.to_account_info().try_borrow_mut_lamports()? += refund_amount;

            // Mark as claimed
            let bet = &mut ctx.accounts.bet;
            bet.claimed = true;

            emit!(PredictionNoWinnerRefund {
                market_id: market_key,
                bettor: bettor_key,
                refund_amount,
            });

            return Ok(());
        }

        // NORMAL WINNER SCENARIO: Pari-mutuel payout
        // Compare project slugs (fixed-size arrays)
        require!(bet.predicted_project == market.winning_project, CasinoError::DidNotWin);

        let gross_winnings = (bet.amount as u128)
            .checked_mul(market.total_pool as u128)
            .ok_or(CasinoError::MathOverflow)?
            .checked_div(winning_pool as u128)
            .ok_or(CasinoError::MathOverflow)? as u64;

        // Calculate early bird discount factor (0-10000 basis points)
        // early_factor = (commit_deadline - committed_at) / (commit_deadline - created_at)
        let commit_duration = market.commit_deadline - market.created_at;
        let time_until_deadline = market.commit_deadline.saturating_sub(bet.committed_at);

        // Calculate early bird factor in basis points (0-10000)
        let early_factor_bps = if commit_duration > 0 {
            ((time_until_deadline as u128) * 10000 / (commit_duration as u128)) as u64
        } else {
            0
        };
        let early_factor_bps = early_factor_bps.min(10000); // Cap at 100%

        // Calculate effective fee with early bird discount
        // effective_fee_bps = house_edge_bps * (1 - early_factor)
        let base_fee_bps = ctx.accounts.house.house_edge_bps as u64;
        let fee_discount_bps = (base_fee_bps * early_factor_bps) / 10000;
        let effective_fee_bps = base_fee_bps.saturating_sub(fee_discount_bps);

        // Calculate fee amount on gross winnings
        let fee = (gross_winnings as u128)
            .checked_mul(effective_fee_bps as u128)
            .ok_or(CasinoError::MathOverflow)?
            .checked_div(10000)
            .ok_or(CasinoError::MathOverflow)? as u64;

        let net_winnings = gross_winnings.saturating_sub(fee);

        // Transfer net winnings to bettor
        **ctx.accounts.market.to_account_info().try_borrow_mut_lamports()? -= net_winnings;
        **ctx.accounts.bettor.to_account_info().try_borrow_mut_lamports()? += net_winnings;

        // Transfer fee to house (if any)
        if fee > 0 {
            **ctx.accounts.market.to_account_info().try_borrow_mut_lamports()? -= fee;
            **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? += fee;

            // Update house pool
            let house = &mut ctx.accounts.house;
            house.pool = house.pool.checked_add(fee).ok_or(CasinoError::MathOverflow)?;
        }

        // Mark as claimed
        let bet = &mut ctx.accounts.bet;
        bet.claimed = true;

        // Update agent stats
        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = bettor_key;
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_won = agent_stats.total_won.checked_add(net_winnings).ok_or(CasinoError::MathOverflow)?;
        agent_stats.wins += 1;

        emit!(PredictionWinningsClaimed {
            market_id: market_key,
            bettor: bettor_key,
            bet_amount,
            winnings: net_winnings,
            early_bird_discount_bps: fee_discount_bps as u16,
            fee_paid: fee,
        });

        Ok(())
    }

    /// Cancel a prediction market and allow refunds (authority only)
    /// Can cancel during Committing or Revealing phase
    pub fn cancel_prediction_market(ctx: Context<CancelPredictionMarket>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(
            market.status == MarketStatus::Committing || market.status == MarketStatus::Revealing,
            CasinoError::MarketNotOpen
        );
        require!(
            ctx.accounts.authority.key() == market.authority,
            CasinoError::NotMarketAuthority
        );

        let market = &mut ctx.accounts.market;
        market.status = MarketStatus::Cancelled;

        emit!(PredictionMarketCancelled {
            market_id: ctx.accounts.market.key(),
        });

        Ok(())
    }

    /// Claim refund from a cancelled prediction market
    pub fn claim_prediction_refund(ctx: Context<ClaimPredictionRefund>) -> Result<()> {
        let market = &ctx.accounts.market;
        let bet = &ctx.accounts.bet;

        require!(market.status == MarketStatus::Cancelled, CasinoError::MarketNotCancelled);
        require!(!bet.claimed, CasinoError::AlreadyClaimed);

        let refund_amount = bet.amount;

        // Transfer refund
        **ctx.accounts.market.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
        **ctx.accounts.bettor.to_account_info().try_borrow_mut_lamports()? += refund_amount;

        // Mark as claimed
        let bet = &mut ctx.accounts.bet;
        bet.claimed = true;

        emit!(PredictionRefundClaimed {
            market_id: ctx.accounts.market.key(),
            bettor: ctx.accounts.bettor.key(),
            refund_amount,
        });

        Ok(())
    }

    // ==================== MEMORY SLOTS ====================
    //
    // A knowledge marketplace where agents stake memories for others to pull.
    // Depositors earn when others pull their memories. Good memories earn more,
    // bad memories lose stake.
    //
    // MECHANICS:
    // - Deposit: Agent submits encrypted content, stakes 0.01 SOL
    // - Pull: Another agent pays pull_price, gets random memory
    // - Rate: After pulling, rater gives 1-5 stars
    // - Stake: Good ratings (4-5) keep stake, bad ratings (1-2) lose stake
    //
    // RANDOMNESS: Uses slot-based randomness weighted by rarity:
    //   Common: 70%, Rare: 25%, Legendary: 5%

    /// Create a new memory pool (slot machine for knowledge)
    pub fn create_memory_pool(
        ctx: Context<CreateMemoryPool>,
        pull_price: u64,
        house_edge_bps: u16,
    ) -> Result<()> {
        require!(pull_price > 0, CasinoError::InvalidAmount);
        require!(house_edge_bps <= 2000, CasinoError::HouseEdgeTooHigh); // Max 20%

        let pool = &mut ctx.accounts.memory_pool;
        pool.authority = ctx.accounts.authority.key();
        pool.pull_price = pull_price;
        pool.house_edge_bps = house_edge_bps;
        pool.stake_amount = 10_000_000; // 0.01 SOL
        pool.total_memories = 0;
        pool.total_pulls = 0;
        pool.pool_balance = 0;
        pool.bump = ctx.bumps.memory_pool;

        emit!(MemoryPoolCreated {
            pool: ctx.accounts.memory_pool.key(),
            authority: ctx.accounts.authority.key(),
            pull_price,
            house_edge_bps,
        });

        Ok(())
    }

    /// Deposit a memory into the pool
    /// Agent stakes SOL and shares their knowledge
    pub fn deposit_memory(
        ctx: Context<DepositMemory>,
        content: String,
        category: MemoryCategory,
        rarity: MemoryRarity,
    ) -> Result<()> {
        require!(content.len() > 0 && content.len() <= 500, CasinoError::MemoryContentInvalid);

        let pool = &ctx.accounts.memory_pool;
        let stake_amount = pool.stake_amount;
        let memory_index = pool.total_memories;

        // Transfer stake to memory pool
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.memory_pool.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, stake_amount)?;

        // Capture keys before mutable borrows
        let pool_key = ctx.accounts.memory_pool.key();
        let depositor_key = ctx.accounts.depositor.key();
        let memory_key = ctx.accounts.memory.key();

        // Update pool stats
        let pool = &mut ctx.accounts.memory_pool;
        pool.total_memories = pool.total_memories.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        pool.pool_balance = pool.pool_balance.checked_add(stake_amount).ok_or(CasinoError::MathOverflow)?;

        // Store memory
        let memory = &mut ctx.accounts.memory;
        memory.pool = pool_key;
        memory.depositor = depositor_key;
        memory.index = memory_index;

        // Store content as fixed-size array
        let mut content_bytes = [0u8; 500];
        let c_bytes = content.as_bytes();
        content_bytes[..c_bytes.len().min(500)].copy_from_slice(&c_bytes[..c_bytes.len().min(500)]);
        memory.content = content_bytes;
        memory.content_length = c_bytes.len() as u16;

        memory.category = category;
        memory.rarity = rarity;
        memory.stake = stake_amount;
        memory.times_pulled = 0;
        memory.total_rating = 0;
        memory.rating_count = 0;
        memory.active = true;
        memory.created_at = Clock::get()?.unix_timestamp;
        memory.bump = ctx.bumps.memory;

        emit!(MemoryDeposited {
            pool: pool_key,
            memory: memory_key,
            depositor: depositor_key,
            category,
            rarity,
            stake: stake_amount,
        });

        Ok(())
    }

    /// Pull a random memory from the pool
    /// Agent pays pull_price, gets random knowledge
    pub fn pull_memory(
        ctx: Context<PullMemory>,
        client_seed: [u8; 32],
    ) -> Result<()> {
        let pool = &ctx.accounts.memory_pool;
        let pull_price = pool.pull_price;
        let house_edge_bps = pool.house_edge_bps;

        // Transfer pull price to memory pool
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.puller.to_account_info(),
                to: ctx.accounts.memory_pool.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, pull_price)?;

        // Calculate house take and depositor share
        let house_take = pull_price * house_edge_bps as u64 / 10000;
        let depositor_share = pull_price - house_take;

        // Transfer house take to house (if house account exists)
        if house_take > 0 {
            **ctx.accounts.memory_pool.to_account_info().try_borrow_mut_lamports()? -= house_take;
            **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? += house_take;
        }

        // Transfer depositor share
        if depositor_share > 0 {
            **ctx.accounts.memory_pool.to_account_info().try_borrow_mut_lamports()? -= depositor_share;
            **ctx.accounts.depositor.to_account_info().try_borrow_mut_lamports()? += depositor_share;
        }

        let clock = Clock::get()?;

        // Capture keys before mutable borrows
        let memory_key = ctx.accounts.memory.key();
        let pool_key = ctx.accounts.memory_pool.key();
        let puller_key = ctx.accounts.puller.key();
        let depositor_key = ctx.accounts.memory.depositor;

        // Get memory content for event
        let memory = &ctx.accounts.memory;
        let content_len = memory.content_length as usize;
        let content = String::from_utf8_lossy(&memory.content[..content_len]).to_string();

        // Update pool stats
        let pool = &mut ctx.accounts.memory_pool;
        pool.total_pulls = pool.total_pulls.checked_add(1).ok_or(CasinoError::MathOverflow)?;

        // Update memory stats
        let memory = &mut ctx.accounts.memory;
        memory.times_pulled = memory.times_pulled.checked_add(1).ok_or(CasinoError::MathOverflow)?;

        // Record the pull
        let pull_record = &mut ctx.accounts.pull_record;
        pull_record.puller = puller_key;
        pull_record.memory = memory_key;
        pull_record.rating = None;
        pull_record.timestamp = clock.unix_timestamp;
        pull_record.bump = ctx.bumps.pull_record;

        emit!(MemoryPulled {
            pool: pool_key,
            memory: memory_key,
            puller: puller_key,
            depositor: depositor_key,
            content,
            pull_price,
            depositor_share,
            house_take,
        });

        Ok(())
    }

    /// Rate a pulled memory
    /// Affects depositor's stake based on rating quality
    pub fn rate_memory(
        ctx: Context<RateMemory>,
        rating: u8,
    ) -> Result<()> {
        require!(rating >= 1 && rating <= 5, CasinoError::InvalidRating);

        let pull_record = &ctx.accounts.pull_record;
        require!(pull_record.rating.is_none(), CasinoError::AlreadyRated);

        let memory = &ctx.accounts.memory;
        let stake = memory.stake;
        let memory_key = ctx.accounts.memory.key();
        let pool_key = ctx.accounts.memory_pool.key();
        let rater_key = ctx.accounts.rater.key();
        let depositor_key = memory.depositor;

        // Process stake based on rating
        let mut stake_change: i64 = 0;
        if rating <= 2 {
            // Bad rating: depositor loses stake to pool
            let memory = &mut ctx.accounts.memory;
            if memory.stake > 0 {
                stake_change = -(memory.stake as i64);
                // Stake already in pool, just zero out memory's stake claim
                memory.stake = 0;
            }
        }
        // Rating 3: neutral, no change
        // Rating 4-5: good, depositor keeps stake (no action needed)

        // Update memory rating stats
        let memory = &mut ctx.accounts.memory;
        memory.total_rating = memory.total_rating.checked_add(rating as u64).ok_or(CasinoError::MathOverflow)?;
        memory.rating_count = memory.rating_count.checked_add(1).ok_or(CasinoError::MathOverflow)?;

        // Record the rating
        let pull_record = &mut ctx.accounts.pull_record;
        pull_record.rating = Some(rating);

        emit!(MemoryRated {
            pool: pool_key,
            memory: memory_key,
            rater: rater_key,
            depositor: depositor_key,
            rating,
            stake_change,
        });

        Ok(())
    }

    /// Withdraw an unpulled memory
    /// Depositor gets stake back minus small fee
    pub fn withdraw_memory(ctx: Context<WithdrawMemory>) -> Result<()> {
        let memory = &ctx.accounts.memory;
        require!(memory.active, CasinoError::MemoryNotActive);
        require!(memory.times_pulled == 0, CasinoError::MemoryAlreadyPulled);
        require!(memory.depositor == ctx.accounts.depositor.key(), CasinoError::NotMemoryOwner);

        let stake = memory.stake;
        // 5% withdrawal fee
        let fee = stake / 20;
        let refund = stake - fee;

        // Transfer refund to depositor
        **ctx.accounts.memory_pool.to_account_info().try_borrow_mut_lamports()? -= refund;
        **ctx.accounts.depositor.to_account_info().try_borrow_mut_lamports()? += refund;

        // Capture keys before mutable borrow
        let pool_key = ctx.accounts.memory_pool.key();
        let memory_key = ctx.accounts.memory.key();
        let depositor_key = ctx.accounts.depositor.key();

        // Update pool balance
        let pool = &mut ctx.accounts.memory_pool;
        pool.pool_balance = pool.pool_balance.saturating_sub(refund);

        // Mark memory as inactive
        let memory = &mut ctx.accounts.memory;
        memory.active = false;
        memory.stake = 0;

        emit!(MemoryWithdrawn {
            pool: pool_key,
            memory: memory_key,
            depositor: depositor_key,
            refund,
            fee,
        });

        Ok(())
    }

    // === Hitman Market Instructions ===

    /// Initialize the hitman pool
    pub fn initialize_hit_pool(
        ctx: Context<InitializeHitPool>,
        house_edge_bps: u16,
    ) -> Result<()> {
        require!(house_edge_bps <= 1000, CasinoError::HouseEdgeTooHigh);

        let pool = &mut ctx.accounts.hit_pool;
        pool.authority = ctx.accounts.authority.key();
        pool.house_edge_bps = house_edge_bps;
        pool.total_hits = 0;
        pool.total_completed = 0;
        pool.total_bounties_paid = 0;
        pool.bump = ctx.bumps.hit_pool;

        emit!(HitPoolInitialized {
            authority: pool.authority,
            house_edge_bps,
        });

        Ok(())
    }

    /// Create a new hit (bounty on agent behavior)
    pub fn create_hit(
        ctx: Context<CreateHit>,
        target_description: String,
        condition: String,
        bounty_amount: u64,
        anonymous: bool,
    ) -> Result<()> {
        require!(target_description.len() >= 10 && target_description.len() <= 200, CasinoError::HitDescriptionInvalid);
        require!(condition.len() >= 10 && condition.len() <= 500, CasinoError::HitConditionInvalid);
        require!(bounty_amount >= 10_000_000, CasinoError::HitBountyTooSmall); // Min 0.01 SOL

        // Transfer bounty to hit vault
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.poster.to_account_info(),
                to: ctx.accounts.hit_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, bounty_amount)?;

        let clock = Clock::get()?;
        let pool = &mut ctx.accounts.hit_pool;
        let hit_index = pool.total_hits;
        pool.total_hits += 1;

        let hit = &mut ctx.accounts.hit;
        hit.pool = ctx.accounts.hit_pool.key();
        hit.poster = ctx.accounts.poster.key();
        hit.target_description = target_description.clone();
        hit.condition = condition.clone();
        hit.bounty = bounty_amount;
        hit.hunter = None;
        hit.proof_link = None;
        hit.anonymous = anonymous;
        hit.status = HitStatus::Open;
        hit.created_at = clock.unix_timestamp;
        hit.claimed_at = None;
        hit.completed_at = None;
        hit.hunter_stake = 0;
        hit.hit_index = hit_index;
        hit.bump = ctx.bumps.hit;

        emit!(HitCreated {
            hit: ctx.accounts.hit.key(),
            poster: if anonymous { Pubkey::default() } else { ctx.accounts.poster.key() },
            target_description,
            condition,
            bounty: bounty_amount,
            anonymous,
        });

        Ok(())
    }

    /// Claim a hit (hunter announces they're going for it)
    pub fn claim_hit(ctx: Context<ClaimHit>, stake_amount: u64) -> Result<()> {
        let hit = &ctx.accounts.hit;
        require!(hit.status == HitStatus::Open, CasinoError::HitNotOpen);
        require!(hit.poster != ctx.accounts.hunter.key(), CasinoError::CannotHuntOwnHit);

        // Minimum stake is 10% of bounty or 0.005 SOL, whichever is higher
        let min_stake = std::cmp::max(hit.bounty / 10, 5_000_000u64);
        require!(stake_amount >= min_stake, CasinoError::StakeTooLow);

        // Transfer stake to hit vault
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.hunter.to_account_info(),
                to: ctx.accounts.hit_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, stake_amount)?;

        let clock = Clock::get()?;
        let hit = &mut ctx.accounts.hit;
        hit.hunter = Some(ctx.accounts.hunter.key());
        hit.status = HitStatus::Claimed;
        hit.claimed_at = Some(clock.unix_timestamp);
        hit.hunter_stake = stake_amount;

        emit!(HitClaimed {
            hit: ctx.accounts.hit.key(),
            hunter: ctx.accounts.hunter.key(),
            claimed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Submit proof that hit was completed
    pub fn submit_proof(ctx: Context<SubmitProof>, proof_link: String) -> Result<()> {
        require!(proof_link.len() >= 1 && proof_link.len() <= 500, CasinoError::ProofLinkInvalid);

        let hit = &ctx.accounts.hit;
        require!(hit.status == HitStatus::Claimed, CasinoError::HitNotClaimed);
        require!(hit.hunter == Some(ctx.accounts.hunter.key()), CasinoError::NotTheHunter);

        let hit = &mut ctx.accounts.hit;
        hit.proof_link = Some(proof_link.clone());
        hit.status = HitStatus::PendingVerification;

        emit!(ProofSubmitted {
            hit: ctx.accounts.hit.key(),
            hunter: ctx.accounts.hunter.key(),
            proof_link,
        });

        Ok(())
    }

    /// Poster verifies the hit (approves or disputes)
    pub fn verify_hit(ctx: Context<VerifyHit>, approved: bool) -> Result<()> {
        let hit = &ctx.accounts.hit;
        require!(hit.status == HitStatus::PendingVerification, CasinoError::HitNotPendingVerification);
        require!(hit.poster == ctx.accounts.poster.key(), CasinoError::NotHitPoster);

        if approved {
            // Pay hunter: bounty + their stake back, minus house edge
            let pool = &ctx.accounts.hit_pool;
            let house_fee = (hit.bounty as u128 * pool.house_edge_bps as u128 / 10000) as u64;
            let payout = hit.bounty.saturating_sub(house_fee) + hit.hunter_stake;

            // Transfer from vault to hunter
            **ctx.accounts.hit_vault.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.hunter.to_account_info().try_borrow_mut_lamports()? += payout;

            let clock = Clock::get()?;
            let hit = &mut ctx.accounts.hit;
            hit.status = HitStatus::Completed;
            hit.completed_at = Some(clock.unix_timestamp);

            let pool = &mut ctx.accounts.hit_pool;
            pool.total_completed += 1;
            pool.total_bounties_paid = pool.total_bounties_paid.checked_add(payout).ok_or(CasinoError::MathOverflow)?;

            emit!(HitCompleted {
                hit: ctx.accounts.hit.key(),
                hunter: ctx.accounts.hunter.key(),
                payout,
            });
        } else {
            // Go to disputed state for arbitration
            let hit = &mut ctx.accounts.hit;
            hit.status = HitStatus::Disputed;

            emit!(HitDisputed {
                hit: ctx.accounts.hit.key(),
                poster: ctx.accounts.poster.key(),
            });
        }

        Ok(())
    }

    /// Cancel an unclaimed hit (poster gets bounty back minus small fee)
    pub fn cancel_hit(ctx: Context<CancelHit>) -> Result<()> {
        let hit = &ctx.accounts.hit;
        require!(hit.status == HitStatus::Open, CasinoError::HitNotOpen);
        require!(hit.poster == ctx.accounts.poster.key(), CasinoError::NotHitPoster);

        // Return bounty minus 1% cancellation fee
        let cancel_fee = hit.bounty / 100;
        let refund = hit.bounty.saturating_sub(cancel_fee);

        // Transfer from vault to poster
        **ctx.accounts.hit_vault.to_account_info().try_borrow_mut_lamports()? -= refund;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += refund;

        let hit = &mut ctx.accounts.hit;
        hit.status = HitStatus::Cancelled;

        emit!(HitCancelled {
            hit: ctx.accounts.hit.key(),
            poster: ctx.accounts.poster.key(),
            refund,
        });

        Ok(())
    }

    /// Expire a claim if hunter doesn't submit proof within 24 hours
    pub fn expire_claim(ctx: Context<ExpireClaim>) -> Result<()> {
        let hit = &ctx.accounts.hit;
        require!(hit.status == HitStatus::Claimed, CasinoError::HitNotClaimed);

        let clock = Clock::get()?;
        let claimed_at = hit.claimed_at.ok_or(CasinoError::HitNotClaimed)?;
        let elapsed = clock.unix_timestamp - claimed_at;
        require!(elapsed >= 86400, CasinoError::ClaimNotExpired); // 24 hours

        // Hunter loses stake to poster as compensation for wasted time
        let stake = hit.hunter_stake;
        let former_hunter = hit.hunter.unwrap_or_default();

        // Transfer forfeited stake to poster
        **ctx.accounts.hit_vault.to_account_info().try_borrow_mut_lamports()? -= stake;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += stake;

        // Hit goes back to open
        let hit = &mut ctx.accounts.hit;
        hit.hunter = None;
        hit.status = HitStatus::Open;
        hit.claimed_at = None;
        hit.hunter_stake = 0;

        emit!(ClaimExpired {
            hit: ctx.accounts.hit.key(),
            former_hunter,
            stake_forfeited: stake,
        });

        Ok(())
    }

    /// Arbitrate a disputed hit (simple majority vote)
    pub fn arbitrate_hit(ctx: Context<ArbitrateHit>, vote_approve: bool) -> Result<()> {
        let hit = &ctx.accounts.hit;
        require!(hit.status == HitStatus::Disputed, CasinoError::HitNotDisputed);

        // Check arbiter hasn't already voted (immutable borrow for checks)
        {
            let arbitration = &ctx.accounts.arbitration;
            require!(!arbitration.arbiters.contains(&ctx.accounts.arbiter.key()), CasinoError::AlreadyVotedArbitration);
            require!(arbitration.arbiters.len() < 3, CasinoError::ArbitrationFull);
        }

        // Arbiter stakes 0.01 SOL (transfer before mutable borrow)
        let stake_amount = 10_000_000u64;
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.arbiter.to_account_info(),
                to: ctx.accounts.arbitration.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, stake_amount)?;

        // Now do mutable updates
        let arbitration = &mut ctx.accounts.arbitration;
        arbitration.arbiters.push(ctx.accounts.arbiter.key());
        arbitration.stakes.push(stake_amount);
        if vote_approve {
            arbitration.votes_approve += 1;
        } else {
            arbitration.votes_reject += 1;
        }
        arbitration.votes.push(vote_approve);

        emit!(ArbitrationVote {
            hit: ctx.accounts.hit.key(),
            arbiter: ctx.accounts.arbiter.key(),
            vote_approve,
            votes_approve: arbitration.votes_approve,
            votes_reject: arbitration.votes_reject,
        });

        // If 3 votes reached, resolve
        if arbitration.arbiters.len() == 3 {
            let hunter_wins = arbitration.votes_approve >= 2;

            if hunter_wins {
                // Pay hunter: bounty + stake back minus house fee
                let pool = &ctx.accounts.hit_pool;
                let house_fee = (hit.bounty as u128 * pool.house_edge_bps as u128 / 10000) as u64;
                let payout = hit.bounty.saturating_sub(house_fee) + hit.hunter_stake;

                **ctx.accounts.hit_vault.to_account_info().try_borrow_mut_lamports()? -= payout;
                **ctx.accounts.hunter.to_account_info().try_borrow_mut_lamports()? += payout;
            } else {
                // Return bounty + hunter stake to poster
                let refund = hit.bounty + hit.hunter_stake;
                **ctx.accounts.hit_vault.to_account_info().try_borrow_mut_lamports()? -= refund;
                **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += refund;
            }

            // Pay winning arbiters, losing arbiters lose stake
            let total_stakes: u64 = arbitration.stakes.iter().sum();
            for i in 0..3 {
                let arbiter = arbitration.arbiters[i];
                let voted_approve = arbitration.votes[i];
                if voted_approve == hunter_wins {
                    // Winner gets their stake + share of losers' stakes
                    let reward = arbitration.stakes[i] + (total_stakes - arbitration.stakes[i]) / 2;
                    // Note: In production, would need to transfer to arbiter accounts
                }
            }

            let clock = Clock::get()?;
            let hit = &mut ctx.accounts.hit;
            hit.status = HitStatus::Completed;
            hit.completed_at = Some(clock.unix_timestamp);

            let pool = &mut ctx.accounts.hit_pool;
            pool.total_completed += 1;
            if hunter_wins {
                pool.total_bounties_paid = pool.total_bounties_paid.checked_add(hit.bounty).ok_or(CasinoError::MathOverflow)?;
            }

            emit!(ArbitrationResolved {
                hit: ctx.accounts.hit.key(),
                hunter_wins,
                votes_approve: arbitration.votes_approve,
                votes_reject: arbitration.votes_reject,
            });
        }

        Ok(())
    }

    // === Multi-Token Support Instructions ===

    /// Initialize a token vault for SPL token betting
    pub fn initialize_token_vault(
        ctx: Context<InitializeTokenVault>,
        house_edge_bps: u16,
        min_bet: u64,
        max_bet_percent: u8,
    ) -> Result<()> {
        require!(house_edge_bps <= 1000, CasinoError::HouseEdgeTooHigh);
        require!(max_bet_percent > 0 && max_bet_percent <= 10, CasinoError::InvalidMaxBet);

        // Create the vault's token account via CPI
        let mint_key = ctx.accounts.mint.key();
        let vault_ata_seeds = &[
            b"token_vault_ata",
            mint_key.as_ref(),
            &[ctx.bumps.vault_ata],
        ];
        let signer_seeds = &[&vault_ata_seeds[..]];

        // Initialize token account
        let rent = Rent::get()?;
        let space = 165; // TokenAccount size
        let lamports = rent.minimum_balance(space);

        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.vault_ata.to_account_info(),
                },
                signer_seeds,
            ),
            lamports,
            space as u64,
            ctx.accounts.token_program.key,
        )?;

        // Initialize as token account
        token::initialize_account3(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::InitializeAccount3 {
                    account: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.token_vault.to_account_info(),
                },
            ),
        )?;

        let vault = &mut ctx.accounts.token_vault;
        vault.authority = ctx.accounts.authority.key();
        vault.mint = ctx.accounts.mint.key();
        vault.vault_ata = ctx.accounts.vault_ata.key();
        vault.pool = 0;
        vault.house_edge_bps = house_edge_bps;
        vault.min_bet = min_bet;
        vault.max_bet_percent = max_bet_percent;
        vault.total_games = 0;
        vault.total_volume = 0;
        vault.total_payout = 0;
        vault.bump = ctx.bumps.token_vault;

        emit!(TokenVaultInitialized {
            vault: vault.key(),
            mint: vault.mint,
            authority: vault.authority,
            house_edge_bps,
            min_bet,
            max_bet_percent,
        });

        Ok(())
    }

    /// Add liquidity to a token vault
    pub fn token_add_liquidity(ctx: Context<TokenAddLiquidity>, amount: u64) -> Result<()> {
        require!(amount > 0, CasinoError::InvalidAmount);

        // Transfer tokens from provider to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.provider_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.provider.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Update LP position
        let lp_position = &mut ctx.accounts.lp_position;
        if lp_position.provider == Pubkey::default() {
            lp_position.provider = ctx.accounts.provider.key();
            lp_position.vault = ctx.accounts.token_vault.key();
            lp_position.mint = ctx.accounts.mint.key();
            lp_position.bump = ctx.bumps.lp_position;
        }
        lp_position.deposited = lp_position.deposited.checked_add(amount).ok_or(CasinoError::MathOverflow)?;

        // Update vault pool
        let vault = &mut ctx.accounts.token_vault;
        vault.pool = vault.pool.checked_add(amount).ok_or(CasinoError::MathOverflow)?;

        emit!(TokenLiquidityAdded {
            vault: vault.key(),
            mint: vault.mint,
            provider: ctx.accounts.provider.key(),
            amount,
            total_pool: vault.pool,
        });

        Ok(())
    }

    /// Token coin flip - 50/50 odds with SPL tokens
    pub fn token_coin_flip(
        ctx: Context<TokenCoinFlip>,
        amount: u64,
        choice: u8,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(choice <= 1, CasinoError::InvalidChoice);

        let vault = &ctx.accounts.token_vault;
        require!(amount >= vault.min_bet, CasinoError::BetTooSmall);
        let max_bet = vault.pool.checked_mul(vault.max_bet_percent as u64).ok_or(CasinoError::MathOverflow)? / 100;
        require!(amount <= max_bet, CasinoError::BetTooLarge);
        require!(vault.pool >= amount * 2, CasinoError::InsufficientLiquidity);

        let clock = Clock::get()?;
        let server_seed = generate_seed(
            ctx.accounts.player.key(),
            clock.slot,
            clock.unix_timestamp,
            ctx.accounts.token_vault.key(),
        );
        let combined = combine_seeds(&server_seed, &client_seed, ctx.accounts.player.key());
        let result = (combined[0] % 2) as u8;

        let won = result == choice;
        let payout = if won {
            calculate_payout(amount, 2_00, vault.house_edge_bps)
        } else {
            0
        };

        // Transfer bet from player to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.player_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.player.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Transfer payout if won (vault is PDA, needs seeds for signing)
        if won && payout > 0 {
            let mint_key = ctx.accounts.mint.key();
            let seeds = &[
                b"token_vault",
                mint_key.as_ref(),
                &[vault.bump],
            ];
            let signer_seeds = &[&seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_ata.to_account_info(),
                to: ctx.accounts.player_ata.to_account_info(),
                authority: ctx.accounts.token_vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, payout)?;
        }

        // Update vault stats
        let vault = &mut ctx.accounts.token_vault;
        vault.total_games = vault.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        vault.total_volume = vault.total_volume.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            vault.total_payout = vault.total_payout.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            vault.pool = vault.pool.checked_sub(payout.saturating_sub(amount)).ok_or(CasinoError::MathOverflow)?;
        } else {
            vault.pool = vault.pool.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        }

        // Update agent stats (shared with SOL games)
        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.player.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games = agent_stats.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            agent_stats.wins += 1;
        } else {
            agent_stats.losses += 1;
        }

        // Record game
        let game_record = &mut ctx.accounts.game_record;
        game_record.player = ctx.accounts.player.key();
        game_record.mint = ctx.accounts.mint.key();
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

        emit!(TokenGamePlayed {
            player: ctx.accounts.player.key(),
            mint: ctx.accounts.mint.key(),
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

    // === Switchboard VRF Instructions ===

    /// Request a VRF-based coin flip - bet is locked until randomness is fulfilled
    pub fn vrf_coin_flip_request(
        ctx: Context<VrfCoinFlipRequest>,
        amount: u64,
        choice: u8,
    ) -> Result<()> {
        require!(choice <= 1, CasinoError::InvalidChoice);

        let house = &ctx.accounts.house;
        require!(amount >= house.min_bet, CasinoError::BetTooSmall);
        let max_bet = house.pool.checked_mul(house.max_bet_percent as u64).ok_or(CasinoError::MathOverflow)? / 100;
        require!(amount <= max_bet, CasinoError::BetTooLarge);
        require!(house.pool >= amount * 2, CasinoError::InsufficientLiquidity);

        // Transfer bet to house
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.house.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        let clock = Clock::get()?;

        // Create VRF request record
        let vrf_request = &mut ctx.accounts.vrf_request;
        vrf_request.player = ctx.accounts.player.key();
        vrf_request.house = ctx.accounts.house.key();
        vrf_request.randomness_account = ctx.accounts.randomness_account.key();
        vrf_request.game_type = GameType::CoinFlip;
        vrf_request.amount = amount;
        vrf_request.choice = choice;
        vrf_request.status = VrfStatus::Pending;
        vrf_request.created_at = clock.unix_timestamp;
        vrf_request.settled_at = 0;
        vrf_request.result = 0;
        vrf_request.payout = 0;
        vrf_request.bump = ctx.bumps.vrf_request;

        // Update house stats
        let house = &mut ctx.accounts.house;
        house.total_games = house.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        house.total_volume = house.total_volume.checked_add(amount).ok_or(CasinoError::MathOverflow)?;

        emit!(VrfRequestCreated {
            request: ctx.accounts.vrf_request.key(),
            player: ctx.accounts.player.key(),
            randomness_account: ctx.accounts.randomness_account.key(),
            game_type: GameType::CoinFlip,
            amount,
            choice,
        });

        Ok(())
    }

    /// Settle a VRF coin flip using Switchboard randomness
    pub fn vrf_coin_flip_settle(ctx: Context<VrfCoinFlipSettle>) -> Result<()> {
        // Load and validate Switchboard randomness
        let randomness_data = RandomnessAccountData::parse(
            ctx.accounts.randomness_account.data.borrow()
        ).map_err(|_| CasinoError::VrfInvalidRandomness)?;

        // Get the revealed randomness value
        let clock = Clock::get()?;
        let randomness = randomness_data.get_value(clock.slot)
            .map_err(|_| CasinoError::VrfRandomnessNotReady)?;

        // Use first byte for coin flip result
        let result = (randomness[0] % 2) as u8;
        let vrf_request = &ctx.accounts.vrf_request;
        let won = result == vrf_request.choice;

        let house = &ctx.accounts.house;
        let payout = if won {
            calculate_payout(vrf_request.amount, 2_00, house.house_edge_bps)
        } else {
            0
        };

        // Transfer payout if won
        if won && payout > 0 {
            **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += payout;
        }

        // Update house pool
        let house = &mut ctx.accounts.house;
        if won {
            house.total_payout = house.total_payout.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            house.pool = house.pool.checked_sub(payout.saturating_sub(vrf_request.amount)).ok_or(CasinoError::MathOverflow)?;
        } else {
            house.pool = house.pool.checked_add(vrf_request.amount).ok_or(CasinoError::MathOverflow)?;
        }

        // Update agent stats
        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = vrf_request.player;
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_games = agent_stats.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        agent_stats.total_wagered = agent_stats.total_wagered.checked_add(vrf_request.amount).ok_or(CasinoError::MathOverflow)?;
        if won {
            agent_stats.total_won = agent_stats.total_won.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
            agent_stats.wins += 1;
        } else {
            agent_stats.losses += 1;
        }

        // Update VRF request
        let request_key = ctx.accounts.vrf_request.key();
        let player_key = ctx.accounts.vrf_request.player;
        let vrf_request = &mut ctx.accounts.vrf_request;
        vrf_request.status = VrfStatus::Settled;
        vrf_request.settled_at = clock.unix_timestamp;
        vrf_request.result = result;
        vrf_request.payout = payout;

        emit!(VrfRequestSettled {
            request: request_key,
            player: player_key,
            randomness: randomness,
            result,
            payout,
            won,
        });

        Ok(())
    }

    // === Pyth Price Prediction Instructions ===

    /// Create a price prediction bet
    pub fn create_price_prediction(
        ctx: Context<CreatePricePrediction>,
        asset: PriceAsset,
        target_price: i64,
        direction: PriceDirection,
        duration_seconds: i64,
        bet_amount: u64,
    ) -> Result<()> {
        let house = &ctx.accounts.house;
        require!(bet_amount >= house.min_bet, CasinoError::BetTooSmall);
        require!(duration_seconds >= 60 && duration_seconds <= 86400 * 7, CasinoError::InvalidDuration);
        require!(target_price > 0, CasinoError::InvalidTargetPrice);

        // Transfer bet to house escrow
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.house.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, bet_amount)?;

        let clock = Clock::get()?;

        // Extract keys before mutable borrow
        let prediction_key = ctx.accounts.price_prediction.key();
        let creator_key = ctx.accounts.creator.key();
        let house_key = ctx.accounts.house.key();
        let bet_index = ctx.accounts.house.total_games;
        let expiry_time = clock.unix_timestamp + duration_seconds;

        // Initialize price prediction
        let prediction = &mut ctx.accounts.price_prediction;
        prediction.house = house_key;
        prediction.creator = creator_key;
        prediction.taker = Pubkey::default();
        prediction.asset = asset;
        prediction.target_price = target_price;
        prediction.direction = direction;
        prediction.bet_amount = bet_amount;
        prediction.creation_time = clock.unix_timestamp;
        prediction.expiry_time = expiry_time;
        prediction.settled_price = 0;
        prediction.winner = Pubkey::default();
        prediction.status = PredictionStatus::Open;
        prediction.bet_index = bet_index;
        prediction.bump = ctx.bumps.price_prediction;

        // Update house stats
        let house = &mut ctx.accounts.house;
        house.total_games = house.total_games.checked_add(1).ok_or(CasinoError::MathOverflow)?;
        house.total_volume = house.total_volume.checked_add(bet_amount).ok_or(CasinoError::MathOverflow)?;

        emit!(PricePredictionCreated {
            prediction: prediction_key,
            creator: creator_key,
            asset,
            target_price,
            direction,
            bet_amount,
            expiry_time,
        });

        Ok(())
    }

    /// Take the opposite side of a price prediction
    pub fn take_price_prediction(ctx: Context<TakePricePrediction>) -> Result<()> {
        let prediction = &ctx.accounts.price_prediction;
        let clock = Clock::get()?;

        // Check not expired
        require!(clock.unix_timestamp < prediction.expiry_time, CasinoError::PriceBetExpired);
        // Check not taking own bet
        require!(ctx.accounts.taker.key() != prediction.creator, CasinoError::CannotTakeOwnBet);

        // Extract values before mutable borrow
        let prediction_key = ctx.accounts.price_prediction.key();
        let taker_key = ctx.accounts.taker.key();
        let bet_amount = prediction.bet_amount;
        let total_pool = bet_amount * 2;

        // Transfer matching bet to house escrow
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.taker.to_account_info(),
                to: ctx.accounts.house.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, bet_amount)?;

        // Update prediction
        let prediction = &mut ctx.accounts.price_prediction;
        prediction.taker = taker_key;
        prediction.status = PredictionStatus::Matched;

        // Update house volume
        let house = &mut ctx.accounts.house;
        house.total_volume = house.total_volume.checked_add(bet_amount).ok_or(CasinoError::MathOverflow)?;

        emit!(PricePredictionTaken {
            prediction: prediction_key,
            taker: taker_key,
            total_pool,
        });

        Ok(())
    }

    /// Settle a price prediction using Pyth oracle
    pub fn settle_price_prediction(ctx: Context<SettlePricePrediction>) -> Result<()> {
        let prediction = &ctx.accounts.price_prediction;
        let clock = Clock::get()?;

        // Check expired (can only settle after expiry)
        require!(clock.unix_timestamp >= prediction.expiry_time, CasinoError::PriceBetNotExpired);

        // Verify creator and taker accounts match
        require!(ctx.accounts.creator.key() == prediction.creator, CasinoError::InvalidCreatorAccount);
        require!(ctx.accounts.taker.key() == prediction.taker, CasinoError::InvalidTakerAccount);

        // Parse Pyth price feed manually
        // Pyth price account structure: magic(4) + version(4) + type(4) + size(4) + price_type(4) +
        // exponent(4) + num_component_prices(4) + num_quoters(4) + last_slot(8) + valid_slot(8) +
        // twap(16) + twac(16) + drv1(8) + drv2(8) + product(32) + next(32) + prev_slot(8) +
        // prev_price(8) + prev_conf(8) + drv3(8) + agg.price(8) + agg.conf(8) + ...
        let price_data = ctx.accounts.price_feed.data.borrow();
        require!(price_data.len() >= 208, CasinoError::InvalidPriceFeed);

        // Check magic number (0xa1b2c3d4 for Pyth V2)
        let magic = u32::from_le_bytes([price_data[0], price_data[1], price_data[2], price_data[3]]);
        require!(magic == 0xa1b2c3d4, CasinoError::InvalidPriceFeed);

        // Get aggregate price (offset 208 in price account)
        // agg.price is at offset 208
        let price_offset = 208;
        let current_price = i64::from_le_bytes([
            price_data[price_offset], price_data[price_offset+1], price_data[price_offset+2], price_data[price_offset+3],
            price_data[price_offset+4], price_data[price_offset+5], price_data[price_offset+6], price_data[price_offset+7],
        ]);

        // Get publish time (for staleness check) - at offset 232
        let time_offset = 232;
        let publish_time = i64::from_le_bytes([
            price_data[time_offset], price_data[time_offset+1], price_data[time_offset+2], price_data[time_offset+3],
            price_data[time_offset+4], price_data[time_offset+5], price_data[time_offset+6], price_data[time_offset+7],
        ]);

        // Check staleness (5 minute threshold)
        require!(clock.unix_timestamp - publish_time < 300, CasinoError::PriceFeedStale);

        // Determine winner based on direction
        let creator_wins = match prediction.direction {
            PriceDirection::Above => current_price >= prediction.target_price,
            PriceDirection::Below => current_price < prediction.target_price,
        };

        let winner = if creator_wins {
            prediction.creator
        } else {
            prediction.taker
        };

        // Calculate payout (total pool minus house edge)
        let total_pool = prediction.bet_amount * 2;
        let house = &ctx.accounts.house;
        let house_take = total_pool * house.house_edge_bps as u64 / 10000;
        let payout = total_pool - house_take;

        // Transfer payout to winner
        let winner_account = if creator_wins {
            ctx.accounts.creator.to_account_info()
        } else {
            ctx.accounts.taker.to_account_info()
        };

        // Extract values for emit before mutable borrow
        let prediction_key = ctx.accounts.price_prediction.key();
        let target_price = prediction.target_price;
        let direction = prediction.direction;

        **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? -= payout;
        **winner_account.try_borrow_mut_lamports()? += payout;

        // Update house stats
        let house = &mut ctx.accounts.house;
        house.total_payout = house.total_payout.checked_add(payout).ok_or(CasinoError::MathOverflow)?;
        house.pool = house.pool.checked_add(house_take).ok_or(CasinoError::MathOverflow)?;

        // Update prediction
        let prediction = &mut ctx.accounts.price_prediction;
        prediction.settled_price = current_price;
        prediction.winner = winner;
        prediction.status = PredictionStatus::Settled;

        emit!(PricePredictionSettled {
            prediction: prediction_key,
            settled_price: current_price,
            target_price,
            direction,
            winner,
            payout,
            house_take,
        });

        Ok(())
    }

    /// Cancel an unmatched price prediction
    pub fn cancel_price_prediction(ctx: Context<CancelPricePrediction>) -> Result<()> {
        let prediction = &ctx.accounts.price_prediction;
        let clock = Clock::get()?;

        // Can only cancel if expired and unmatched
        require!(clock.unix_timestamp >= prediction.expiry_time, CasinoError::PriceBetNotExpired);

        // Extract values for emit
        let prediction_key = ctx.accounts.price_prediction.key();
        let creator_key = ctx.accounts.creator.key();
        let refund = prediction.bet_amount;

        // Refund creator
        **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? -= refund;
        **ctx.accounts.creator.to_account_info().try_borrow_mut_lamports()? += refund;

        // Update prediction
        let prediction = &mut ctx.accounts.price_prediction;
        prediction.status = PredictionStatus::Cancelled;

        emit!(PricePredictionCancelled {
            prediction: prediction_key,
            creator: creator_key,
            refund,
        });

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

/// Calculate crash point using exponential distribution
/// This creates the classic Crash game feel where most games crash early
/// but occasionally can go very high. Uses formula: crash_point = 99 / (1 - e)
/// where e is the normalized random value, giving ~1% house edge
fn calculate_crash_point(raw: u32, house_edge_bps: u16) -> u16 {
    let max = u32::MAX as f64;
    let normalized = raw as f64 / max;

    // Classic crash formula with house edge adjustment
    // Base formula: 99 / (1 - normalized * 0.99)
    // This creates exponential distribution with 1% built-in edge
    let edge_factor = 1.0 - (house_edge_bps as f64 / 10000.0);

    // Crash point calculation - inverse exponential distribution
    // Most games crash between 1x-3x, but can occasionally go 50x+
    let divisor = 1.0 - (normalized * 0.99);
    let crash_multiplier = if divisor > 0.001 {
        (99.0 * edge_factor / divisor)
    } else {
        10000.0 // Cap at 100x for edge cases
    };

    // Return as integer (100 = 1.00x, 200 = 2.00x, etc.)
    (crash_multiplier.min(10000.0) as u16).max(100)
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
    /// CHECK: Manual reallocation for migration of old-size accounts
    #[account(
        mut,
        seeds = [b"agent", agent.key().as_ref()],
        bump
    )]
    pub agent_stats: UncheckedAccount<'info>,

    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// === PvP Challenge Account Structures ===

#[derive(Accounts)]
#[instruction(amount: u64, choice: u8, nonce: u64)]
pub struct CreateChallenge<'info> {
    #[account(seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        init,
        payer = challenger,
        space = 8 + Challenge::INIT_SPACE,
        seeds = [b"challenge", challenger.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub challenge: Account<'info, Challenge>,

    #[account(mut)]
    pub challenger: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptChallenge<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        constraint = challenge.status == ChallengeStatus::Open @ CasinoError::ChallengeNotOpen
    )]
    pub challenge: Account<'info, Challenge>,

    /// CHECK: The original challenger, verified by challenge.challenger
    #[account(
        mut,
        constraint = challenger.key() == challenge.challenger @ CasinoError::InvalidChallenger
    )]
    pub challenger: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = acceptor,
        space = 8 + AgentStats::INIT_SPACE,
        seeds = [b"agent", challenge.challenger.as_ref()],
        bump
    )]
    pub challenger_stats: Account<'info, AgentStats>,

    #[account(
        init_if_needed,
        payer = acceptor,
        space = 8 + AgentStats::INIT_SPACE,
        seeds = [b"agent", acceptor.key().as_ref()],
        bump
    )]
    pub acceptor_stats: Account<'info, AgentStats>,

    #[account(mut)]
    pub acceptor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelChallenge<'info> {
    #[account(
        mut,
        constraint = challenge.challenger == challenger.key() @ CasinoError::NotChallengeOwner,
        constraint = challenge.status == ChallengeStatus::Open @ CasinoError::ChallengeNotOpen
    )]
    pub challenge: Account<'info, Challenge>,

    #[account(mut)]
    pub challenger: Signer<'info>,
}

// === Prediction Market Account Structures ===

#[derive(Accounts)]
#[instruction(market_id: u64, question: String, commit_deadline: i64, reveal_deadline: i64)]
pub struct CreatePredictionMarket<'info> {
    #[account(seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        init,
        payer = authority,
        space = 8 + PredictionMarket::INIT_SPACE,
        seeds = [b"pred_mkt", &market_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, PredictionMarket>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// COMMIT PHASE: Submit hidden bet (hash only)
#[derive(Accounts)]
#[instruction(commitment: [u8; 32], amount: u64)]
pub struct CommitPredictionBet<'info> {
    #[account(seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        constraint = market.status == MarketStatus::Committing @ CasinoError::NotInCommitPhase
    )]
    pub market: Account<'info, PredictionMarket>,

    #[account(
        init,
        payer = bettor,
        space = 8 + PredictionBet::INIT_SPACE,
        seeds = [b"pred_bet", market.key().as_ref(), bettor.key().as_ref()],
        bump
    )]
    pub bet: Account<'info, PredictionBet>,

    #[account(mut)]
    pub bettor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// Transition from Committing to Revealing
#[derive(Accounts)]
pub struct StartRevealPhase<'info> {
    #[account(
        mut,
        constraint = market.status == MarketStatus::Committing @ CasinoError::NotInCommitPhase
    )]
    pub market: Account<'info, PredictionMarket>,
}

// REVEAL PHASE: Reveal your committed bet
#[derive(Accounts)]
#[instruction(predicted_project: String, salt: [u8; 32])]
pub struct RevealPredictionBet<'info> {
    #[account(
        mut,
        constraint = market.status == MarketStatus::Revealing @ CasinoError::NotInRevealPhase
    )]
    pub market: Account<'info, PredictionMarket>,

    #[account(
        mut,
        seeds = [b"pred_bet", market.key().as_ref(), bettor.key().as_ref()],
        bump = bet.bump,
        constraint = bet.bettor == bettor.key() @ CasinoError::NotBetOwner
    )]
    pub bet: Account<'info, PredictionBet>,

    #[account(mut)]
    pub bettor: Signer<'info>,
}

// Forfeit unrevealed bet after reveal deadline
#[derive(Accounts)]
pub struct ForfeitUnrevealedBet<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(mut)]
    pub market: Account<'info, PredictionMarket>,

    #[account(
        mut,
        seeds = [b"pred_bet", market.key().as_ref(), bet.bettor.as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, PredictionBet>,
}

#[derive(Accounts)]
pub struct ResolvePredictionMarket<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        constraint = market.authority == authority.key() @ CasinoError::NotMarketAuthority
    )]
    pub market: Account<'info, PredictionMarket>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimPredictionWinnings<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        constraint = market.status == MarketStatus::Resolved @ CasinoError::MarketNotResolved
    )]
    pub market: Account<'info, PredictionMarket>,

    #[account(
        mut,
        seeds = [b"pred_bet", market.key().as_ref(), bettor.key().as_ref()],
        bump = bet.bump,
        constraint = bet.bettor == bettor.key() @ CasinoError::NotBetOwner
    )]
    pub bet: Account<'info, PredictionBet>,

    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + AgentStats::INIT_SPACE,
        seeds = [b"agent", bettor.key().as_ref()],
        bump
    )]
    pub agent_stats: Account<'info, AgentStats>,

    #[account(mut)]
    pub bettor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelPredictionMarket<'info> {
    #[account(
        mut,
        constraint = market.authority == authority.key() @ CasinoError::NotMarketAuthority
    )]
    pub market: Account<'info, PredictionMarket>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimPredictionRefund<'info> {
    #[account(
        mut,
        constraint = market.status == MarketStatus::Cancelled @ CasinoError::MarketNotCancelled
    )]
    pub market: Account<'info, PredictionMarket>,

    #[account(
        mut,
        seeds = [b"pred_bet", market.key().as_ref(), bettor.key().as_ref()],
        bump = bet.bump,
        constraint = bet.bettor == bettor.key() @ CasinoError::NotBetOwner
    )]
    pub bet: Account<'info, PredictionBet>,

    #[account(mut)]
    pub bettor: Signer<'info>,
}

// === Memory Slots Account Structures ===

#[derive(Accounts)]
pub struct CreateMemoryPool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + MemoryPool::INIT_SPACE,
        seeds = [b"memory_pool"],
        bump
    )]
    pub memory_pool: Account<'info, MemoryPool>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(content: String, category: MemoryCategory, rarity: MemoryRarity)]
pub struct DepositMemory<'info> {
    #[account(
        mut,
        seeds = [b"memory_pool"],
        bump = memory_pool.bump
    )]
    pub memory_pool: Account<'info, MemoryPool>,

    #[account(
        init,
        payer = depositor,
        space = 8 + Memory::INIT_SPACE,
        seeds = [b"memory", memory_pool.key().as_ref(), &memory_pool.total_memories.to_le_bytes()],
        bump
    )]
    pub memory: Account<'info, Memory>,

    #[account(mut)]
    pub depositor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PullMemory<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        seeds = [b"memory_pool"],
        bump = memory_pool.bump
    )]
    pub memory_pool: Account<'info, MemoryPool>,

    #[account(
        mut,
        constraint = memory.active @ CasinoError::MemoryNotActive,
        constraint = memory.pool == memory_pool.key() @ CasinoError::MemoryPoolMismatch
    )]
    pub memory: Account<'info, Memory>,

    /// CHECK: The memory depositor, verified against memory.depositor
    #[account(
        mut,
        constraint = depositor.key() == memory.depositor @ CasinoError::InvalidDepositor
    )]
    pub depositor: AccountInfo<'info>,

    #[account(
        init,
        payer = puller,
        space = 8 + MemoryPull::INIT_SPACE,
        seeds = [b"mem_pull", memory.key().as_ref(), puller.key().as_ref()],
        bump
    )]
    pub pull_record: Account<'info, MemoryPull>,

    #[account(mut)]
    pub puller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RateMemory<'info> {
    #[account(
        mut,
        seeds = [b"memory_pool"],
        bump = memory_pool.bump
    )]
    pub memory_pool: Account<'info, MemoryPool>,

    #[account(
        mut,
        constraint = memory.pool == memory_pool.key() @ CasinoError::MemoryPoolMismatch
    )]
    pub memory: Account<'info, Memory>,

    #[account(
        mut,
        seeds = [b"mem_pull", memory.key().as_ref(), rater.key().as_ref()],
        bump = pull_record.bump,
        constraint = pull_record.puller == rater.key() @ CasinoError::NotPullOwner
    )]
    pub pull_record: Account<'info, MemoryPull>,

    #[account(mut)]
    pub rater: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawMemory<'info> {
    #[account(
        mut,
        seeds = [b"memory_pool"],
        bump = memory_pool.bump
    )]
    pub memory_pool: Account<'info, MemoryPool>,

    #[account(
        mut,
        constraint = memory.pool == memory_pool.key() @ CasinoError::MemoryPoolMismatch,
        constraint = memory.depositor == depositor.key() @ CasinoError::NotMemoryOwner
    )]
    pub memory: Account<'info, Memory>,

    #[account(mut)]
    pub depositor: Signer<'info>,
}

// === Hitman Market Account Structures ===

#[derive(Accounts)]
pub struct InitializeHitPool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + HitPool::INIT_SPACE,
        seeds = [b"hit_pool"],
        bump
    )]
    pub hit_pool: Account<'info, HitPool>,

    #[account(
        mut,
        seeds = [b"hit_vault", hit_pool.key().as_ref()],
        bump
    )]
    /// CHECK: PDA vault for holding bounties and stakes
    pub hit_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(target_description: String, condition: String, bounty_amount: u64, anonymous: bool)]
pub struct CreateHit<'info> {
    #[account(mut, seeds = [b"hit_pool"], bump = hit_pool.bump)]
    pub hit_pool: Account<'info, HitPool>,

    #[account(
        init,
        payer = poster,
        space = 8 + Hit::INIT_SPACE,
        seeds = [b"hit", hit_pool.key().as_ref(), &hit_pool.total_hits.to_le_bytes()],
        bump
    )]
    pub hit: Account<'info, Hit>,

    #[account(
        mut,
        seeds = [b"hit_vault", hit_pool.key().as_ref()],
        bump
    )]
    /// CHECK: PDA vault for holding bounties
    pub hit_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(stake_amount: u64)]
pub struct ClaimHit<'info> {
    #[account(seeds = [b"hit_pool"], bump = hit_pool.bump)]
    pub hit_pool: Account<'info, HitPool>,

    #[account(
        mut,
        constraint = hit.status == HitStatus::Open @ CasinoError::HitNotOpen,
        constraint = hit.pool == hit_pool.key() @ CasinoError::HitPoolMismatch
    )]
    pub hit: Account<'info, Hit>,

    #[account(
        mut,
        seeds = [b"hit_vault", hit_pool.key().as_ref()],
        bump
    )]
    /// CHECK: PDA vault for holding stakes
    pub hit_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub hunter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof_link: String)]
pub struct SubmitProof<'info> {
    #[account(
        mut,
        constraint = hit.status == HitStatus::Claimed @ CasinoError::HitNotClaimed,
        constraint = hit.hunter == Some(hunter.key()) @ CasinoError::NotTheHunter
    )]
    pub hit: Account<'info, Hit>,

    #[account(mut)]
    pub hunter: Signer<'info>,
}

#[derive(Accounts)]
pub struct VerifyHit<'info> {
    #[account(mut, seeds = [b"hit_pool"], bump = hit_pool.bump)]
    pub hit_pool: Account<'info, HitPool>,

    #[account(
        mut,
        constraint = hit.status == HitStatus::PendingVerification @ CasinoError::HitNotPendingVerification,
        constraint = hit.poster == poster.key() @ CasinoError::NotHitPoster,
        constraint = hit.pool == hit_pool.key() @ CasinoError::HitPoolMismatch
    )]
    pub hit: Account<'info, Hit>,

    #[account(
        mut,
        seeds = [b"hit_vault", hit_pool.key().as_ref()],
        bump
    )]
    /// CHECK: PDA vault holding bounty
    pub hit_vault: UncheckedAccount<'info>,

    /// CHECK: Hunter account to receive payout - validated against hit
    #[account(mut, constraint = hunter.key() == hit.hunter.unwrap() @ CasinoError::NotTheHunter)]
    pub hunter: AccountInfo<'info>,

    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelHit<'info> {
    #[account(seeds = [b"hit_pool"], bump = hit_pool.bump)]
    pub hit_pool: Account<'info, HitPool>,

    #[account(
        mut,
        constraint = hit.status == HitStatus::Open @ CasinoError::HitNotOpen,
        constraint = hit.poster == poster.key() @ CasinoError::NotHitPoster,
        constraint = hit.pool == hit_pool.key() @ CasinoError::HitPoolMismatch
    )]
    pub hit: Account<'info, Hit>,

    #[account(
        mut,
        seeds = [b"hit_vault", hit_pool.key().as_ref()],
        bump
    )]
    /// CHECK: PDA vault holding bounty
    pub hit_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExpireClaim<'info> {
    #[account(seeds = [b"hit_pool"], bump = hit_pool.bump)]
    pub hit_pool: Account<'info, HitPool>,

    #[account(
        mut,
        constraint = hit.status == HitStatus::Claimed @ CasinoError::HitNotClaimed,
        constraint = hit.pool == hit_pool.key() @ CasinoError::HitPoolMismatch
    )]
    pub hit: Account<'info, Hit>,

    #[account(
        mut,
        seeds = [b"hit_vault", hit_pool.key().as_ref()],
        bump
    )]
    /// CHECK: PDA vault holding stake
    pub hit_vault: UncheckedAccount<'info>,

    /// CHECK: Poster to receive slashed stake - validated against hit
    #[account(mut, constraint = poster.key() == hit.poster @ CasinoError::NotHitPoster)]
    pub poster: AccountInfo<'info>,

    /// CHECK: Anyone can call this to expire a stale claim
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vote_for_hunter: bool)]
pub struct ArbitrateHit<'info> {
    #[account(mut, seeds = [b"hit_pool"], bump = hit_pool.bump)]
    pub hit_pool: Account<'info, HitPool>,

    #[account(
        mut,
        constraint = hit.status == HitStatus::Disputed @ CasinoError::HitNotDisputed,
        constraint = hit.pool == hit_pool.key() @ CasinoError::HitPoolMismatch
    )]
    pub hit: Account<'info, Hit>,

    #[account(
        mut,
        seeds = [b"hit_vault", hit_pool.key().as_ref()],
        bump
    )]
    /// CHECK: PDA vault holding bounty and stake
    pub hit_vault: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = arbiter,
        space = 8 + Arbitration::INIT_SPACE,
        seeds = [b"arbitration", hit.key().as_ref()],
        bump
    )]
    pub arbitration: Account<'info, Arbitration>,

    /// CHECK: Hunter account for potential payout - validated against hit
    #[account(mut, constraint = hunter.key() == hit.hunter.unwrap() @ CasinoError::NotTheHunter)]
    pub hunter: AccountInfo<'info>,

    /// CHECK: Poster account for potential refund - validated against hit
    #[account(mut, constraint = poster.key() == hit.poster @ CasinoError::NotHitPoster)]
    pub poster: AccountInfo<'info>,

    #[account(mut)]
    pub arbiter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// === Multi-Token Contexts ===

#[derive(Accounts)]
pub struct InitializeTokenVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + TokenVault::INIT_SPACE,
        seeds = [b"token_vault", mint.key().as_ref()],
        bump
    )]
    pub token_vault: Account<'info, TokenVault>,

    /// CHECK: SPL token mint - validated by token program
    pub mint: UncheckedAccount<'info>,

    /// CHECK: The vault's token account (ATA) - initialized by token program
    #[account(
        mut,
        seeds = [b"token_vault_ata", mint.key().as_ref()],
        bump
    )]
    pub vault_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: Rent sysvar
    pub rent: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TokenAddLiquidity<'info> {
    #[account(
        mut,
        seeds = [b"token_vault", mint.key().as_ref()],
        bump = token_vault.bump
    )]
    pub token_vault: Account<'info, TokenVault>,

    /// CHECK: SPL token mint
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Vault's token account
    #[account(
        mut,
        seeds = [b"token_vault_ata", mint.key().as_ref()],
        bump
    )]
    pub vault_ata: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = provider,
        space = 8 + TokenLpPosition::INIT_SPACE,
        seeds = [b"token_lp", token_vault.key().as_ref(), provider.key().as_ref()],
        bump
    )]
    pub lp_position: Account<'info, TokenLpPosition>,

    /// CHECK: Provider's token account - validated by token program
    #[account(mut)]
    pub provider_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub provider: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TokenCoinFlip<'info> {
    #[account(
        mut,
        seeds = [b"token_vault", mint.key().as_ref()],
        bump = token_vault.bump
    )]
    pub token_vault: Account<'info, TokenVault>,

    /// CHECK: SPL token mint
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Vault's token account
    #[account(
        mut,
        seeds = [b"token_vault_ata", mint.key().as_ref()],
        bump
    )]
    pub vault_ata: UncheckedAccount<'info>,

    #[account(
        init,
        payer = player,
        space = 8 + TokenGameRecord::INIT_SPACE,
        seeds = [b"token_game", token_vault.key().as_ref(), &token_vault.total_games.to_le_bytes()],
        bump
    )]
    pub game_record: Account<'info, TokenGameRecord>,

    #[account(
        init_if_needed,
        payer = player,
        space = 8 + AgentStats::INIT_SPACE,
        seeds = [b"agent", player.key().as_ref()],
        bump
    )]
    pub agent_stats: Account<'info, AgentStats>,

    /// CHECK: Player's token account - validated by token program
    #[account(mut)]
    pub player_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub player: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// === Switchboard VRF Contexts ===

#[derive(Accounts)]
pub struct VrfCoinFlipRequest<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        init,
        payer = player,
        space = 8 + VrfRequest::INIT_SPACE,
        seeds = [b"vrf_request", player.key().as_ref(), &house.total_games.to_le_bytes()],
        bump
    )]
    pub vrf_request: Account<'info, VrfRequest>,

    /// CHECK: Switchboard randomness account - validated in instruction
    pub randomness_account: UncheckedAccount<'info>,

    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VrfCoinFlipSettle<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        seeds = [b"vrf_request", vrf_request.player.as_ref(), &house.total_games.saturating_sub(1).to_le_bytes()],
        bump = vrf_request.bump,
        constraint = vrf_request.status == VrfStatus::Pending @ CasinoError::VrfAlreadySettled
    )]
    pub vrf_request: Account<'info, VrfRequest>,

    #[account(
        init_if_needed,
        payer = settler,
        space = 8 + AgentStats::INIT_SPACE,
        seeds = [b"agent", vrf_request.player.as_ref()],
        bump
    )]
    pub agent_stats: Account<'info, AgentStats>,

    /// CHECK: Switchboard randomness account - validated against vrf_request
    #[account(constraint = randomness_account.key() == vrf_request.randomness_account @ CasinoError::VrfInvalidRandomness)]
    pub randomness_account: UncheckedAccount<'info>,

    /// CHECK: Player to receive payout - validated against vrf_request
    #[account(mut, constraint = player.key() == vrf_request.player @ CasinoError::InvalidCreatorAccount)]
    pub player: UncheckedAccount<'info>,

    #[account(mut)]
    pub settler: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// === Pyth Price Prediction Contexts ===

#[derive(Accounts)]
pub struct CreatePricePrediction<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        init,
        payer = creator,
        space = 8 + PricePrediction::INIT_SPACE,
        seeds = [b"price_bet", house.key().as_ref(), &house.total_games.to_le_bytes()],
        bump
    )]
    pub price_prediction: Account<'info, PricePrediction>,

    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TakePricePrediction<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        constraint = price_prediction.status == PredictionStatus::Open @ CasinoError::PriceBetNotOpen,
        constraint = price_prediction.taker == Pubkey::default() @ CasinoError::PriceBetAlreadyTaken
    )]
    pub price_prediction: Account<'info, PricePrediction>,

    #[account(mut)]
    pub taker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePricePrediction<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        constraint = price_prediction.status == PredictionStatus::Matched @ CasinoError::PriceBetNotMatched
    )]
    pub price_prediction: Account<'info, PricePrediction>,

    /// CHECK: Pyth price feed account - owner validated against Pyth program
    #[account(constraint = *price_feed.owner == PYTH_PROGRAM_ID @ CasinoError::InvalidPriceFeed)]
    pub price_feed: UncheckedAccount<'info>,

    /// CHECK: Creator to receive payout - validated against prediction
    #[account(mut, constraint = creator.key() == price_prediction.creator @ CasinoError::InvalidCreatorAccount)]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: Taker to receive payout - validated against prediction
    #[account(mut, constraint = taker.key() == price_prediction.taker @ CasinoError::InvalidTakerAccount)]
    pub taker: UncheckedAccount<'info>,

    #[account(mut)]
    pub settler: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelPricePrediction<'info> {
    #[account(mut, seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        constraint = price_prediction.status == PredictionStatus::Open @ CasinoError::PriceBetNotOpen,
        constraint = price_prediction.creator == creator.key() @ CasinoError::NotPriceBetCreator
    )]
    pub price_prediction: Account<'info, PricePrediction>,

    #[account(mut)]
    pub creator: Signer<'info>,
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
    pub pvp_games: u64,
    pub pvp_wins: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Challenge {
    pub challenger: Pubkey,
    pub acceptor: Pubkey,
    pub amount: u64,
    pub choice: u8,              // 0 = heads, 1 = tails
    pub status: ChallengeStatus,
    pub result: u8,
    pub winner: Pubkey,
    pub server_seed: [u8; 32],
    pub client_seed: [u8; 32],
    pub created_at: i64,
    pub completed_at: i64,
    pub nonce: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PredictionMarket {
    pub authority: Pubkey,
    pub market_id: u64,
    pub question: [u8; 200],             // Question text (fixed size, null-padded)
    pub total_pool: u64,                 // Final pool after reveal phase
    pub total_committed: u64,            // Amount committed (before reveals)
    pub winning_pool: u64,               // Total bet on winning project (set at resolution)
    pub status: MarketStatus,
    pub winning_project: [u8; 50],       // Winning project slug (fixed size, null-padded)
    pub commit_deadline: i64,            // When commit phase ends
    pub reveal_deadline: i64,            // When reveal phase ends
    pub resolved_at: i64,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PredictionBet {
    pub bettor: Pubkey,
    pub market: Pubkey,
    pub commitment: [u8; 32],            // hash(project_slug || salt) - hidden until reveal
    pub predicted_project: [u8; 50],     // Project slug (null-padded, zeroed until revealed)
    pub amount: u64,
    pub committed_at: i64,               // Timestamp for early bird bonus calculation
    pub revealed: bool,                  // True after reveal phase
    pub claimed: bool,
    pub bump: u8,
}

// === Memory Slots State Accounts ===

#[account]
#[derive(InitSpace)]
pub struct MemoryPool {
    pub authority: Pubkey,
    pub pull_price: u64,            // Price to pull a random memory
    pub house_edge_bps: u16,        // House edge in basis points (e.g., 1000 = 10%)
    pub stake_amount: u64,          // Amount depositors must stake (0.01 SOL)
    pub total_memories: u64,        // Total memories ever deposited
    pub total_pulls: u64,           // Total pulls ever made
    pub pool_balance: u64,          // Current SOL in the pool (stakes + unclaimed)
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Memory {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub index: u64,                 // Memory index in pool
    #[max_len(500)]
    pub content: [u8; 500],         // Memory content (max 500 chars)
    pub content_length: u16,        // Actual content length
    pub category: MemoryCategory,
    pub rarity: MemoryRarity,
    pub stake: u64,                 // Remaining stake (can be lost via bad ratings)
    pub times_pulled: u64,
    pub total_rating: u64,          // Sum of all ratings
    pub rating_count: u64,          // Number of ratings
    pub active: bool,               // Can still be pulled
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MemoryPull {
    pub puller: Pubkey,
    pub memory: Pubkey,
    pub rating: Option<u8>,         // 1-5 rating, None if not yet rated
    pub timestamp: i64,
    pub bump: u8,
}

// === Hitman Market State Accounts ===

#[account]
#[derive(InitSpace)]
pub struct HitPool {
    pub authority: Pubkey,
    pub house_edge_bps: u16,
    pub total_hits: u64,
    pub total_completed: u64,
    pub total_bounties_paid: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Hit {
    pub pool: Pubkey,
    pub poster: Pubkey,
    #[max_len(500)]
    pub target_description: String,  // Who is being targeted
    #[max_len(500)]
    pub condition: String,           // What needs to happen
    pub bounty: u64,
    pub hunter: Option<Pubkey>,
    #[max_len(500)]
    pub proof_link: Option<String>,  // Forum URL, tx hash, etc.
    pub anonymous: bool,             // Hide poster identity until resolved
    pub status: HitStatus,
    pub created_at: i64,
    pub claimed_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub hunter_stake: u64,           // Hunter's stake (lost if they fail)
    pub hit_index: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Arbitration {
    pub hit: Pubkey,
    pub votes_approve: u8,
    pub votes_reject: u8,
    #[max_len(3)]
    pub arbiters: Vec<Pubkey>,
    #[max_len(3)]
    pub stakes: Vec<u64>,
    #[max_len(3)]
    pub votes: Vec<bool>,            // true = approve, false = reject
    pub bump: u8,
}

// === Multi-Token Support ===

/// Token vault for SPL token betting
/// Each token mint gets its own vault with independent pool and settings
#[account]
#[derive(InitSpace)]
pub struct TokenVault {
    pub authority: Pubkey,           // House authority
    pub mint: Pubkey,                // SPL token mint address
    pub vault_ata: Pubkey,           // Associated token account holding tokens
    pub pool: u64,                   // Total tokens in the pool
    pub house_edge_bps: u16,         // House edge in basis points
    pub min_bet: u64,                // Minimum bet in token units
    pub max_bet_percent: u8,         // Max bet as % of pool
    pub total_games: u64,
    pub total_volume: u64,
    pub total_payout: u64,
    pub bump: u8,
}

/// LP position for token-based liquidity
#[account]
#[derive(InitSpace)]
pub struct TokenLpPosition {
    pub provider: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub deposited: u64,
    pub bump: u8,
}

/// Token game record for auditing
#[account]
#[derive(InitSpace)]
pub struct TokenGameRecord {
    pub player: Pubkey,
    pub mint: Pubkey,
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

// === Switchboard VRF Support ===

/// VRF game request - holds bet until randomness is fulfilled
#[account]
#[derive(InitSpace)]
pub struct VrfRequest {
    pub player: Pubkey,
    pub house: Pubkey,
    pub randomness_account: Pubkey,  // Switchboard randomness account
    pub game_type: GameType,
    pub amount: u64,
    pub choice: u8,
    pub status: VrfStatus,
    pub created_at: i64,
    pub settled_at: i64,
    pub result: u8,
    pub payout: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum VrfStatus {
    Pending,    // Waiting for randomness
    Settled,    // Game completed
    Expired,    // Timeout - refund available
}

// === Pyth Price Prediction Support ===

/// Price prediction bet - bet on real-world price movements
#[account]
#[derive(InitSpace)]
pub struct PricePrediction {
    pub house: Pubkey,
    pub creator: Pubkey,
    pub taker: Pubkey,           // Pubkey::default() if no taker yet
    pub asset: PriceAsset,
    pub target_price: i64,       // Price with Pyth decimals (8 decimals for USD)
    pub direction: PriceDirection,
    pub bet_amount: u64,
    pub creation_time: i64,
    pub expiry_time: i64,
    pub settled_price: i64,      // 0 if not settled
    pub winner: Pubkey,          // Pubkey::default() if not settled
    pub status: PredictionStatus,
    pub bet_index: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PriceAsset {
    BTC,
    SOL,
    ETH,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PriceDirection {
    Above,
    Below,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
pub enum PredictionStatus {
    #[default]
    Open,       // Waiting for taker
    Matched,    // Both sides filled
    Settled,    // Oracle settled
    Cancelled,  // Creator cancelled (unmatched)
}

// === Types ===

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum GameType {
    CoinFlip,
    DiceRoll,
    Limbo,
    PvPChallenge,
    Crash,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ChallengeStatus {
    Open,
    Completed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Committing,   // Phase 1: Bets are hidden (commit hash only)
    Revealing,    // Phase 2: Bettors reveal their choices
    Resolved,     // Phase 3: Winner declared, payouts available
    Cancelled,    // Market cancelled, refunds available
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
pub enum HitStatus {
    #[default]
    Open,               // Available for hunters to claim
    Claimed,            // Hunter is working on it
    PendingVerification, // Proof submitted, waiting for poster to verify
    Disputed,           // Poster rejected, going to arbitration
    Completed,          // Hit completed successfully
    Cancelled,          // Poster cancelled the hit
}

// Memory Slots enums

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MemoryCategory {
    Strategy,     // Trading/gambling strategies
    Technical,    // Technical knowledge, code, APIs
    Alpha,        // Alpha information, market insights
    Random,       // Misc/fun/creative content
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MemoryRarity {
    Common,       // 70% pull chance
    Rare,         // 25% pull chance
    Legendary,    // 5% pull chance
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

#[event]
pub struct CrashPlayed {
    pub player: Pubkey,
    pub amount: u64,
    pub cashout_multiplier: u16,
    pub crash_point: u16,
    pub payout: u64,
    pub won: bool,
    pub server_seed: [u8; 32],
    pub client_seed: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct ChallengeCreated {
    pub challenge_id: Pubkey,
    pub challenger: Pubkey,
    pub amount: u64,
    pub choice: u8,
    pub created_at: i64,
}

#[event]
pub struct ChallengeAccepted {
    pub challenge_id: Pubkey,
    pub challenger: Pubkey,
    pub acceptor: Pubkey,
    pub amount: u64,
    pub challenger_choice: u8,
    pub result: u8,
    pub winner: Pubkey,
    pub payout: u64,
    pub house_take: u64,
}

#[event]
pub struct ChallengeCancelled {
    pub challenge_id: Pubkey,
    pub challenger: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PredictionMarketCreated {
    pub market_id: Pubkey,
    pub authority: Pubkey,
    pub question: String,
    pub commit_deadline: i64,
    pub reveal_deadline: i64,
}

#[event]
pub struct PredictionBetCommitted {
    pub market_id: Pubkey,
    pub bettor: Pubkey,
    pub commitment: [u8; 32],  // Hash only - choice is hidden
    pub amount: u64,
    pub total_committed: u64,
}

#[event]
pub struct RevealPhaseStarted {
    pub market_id: Pubkey,
    pub total_committed: u64,
}

#[event]
pub struct PredictionBetRevealed {
    pub market_id: Pubkey,
    pub bettor: Pubkey,
    pub predicted_project: String,
    pub amount: u64,
}

#[event]
pub struct BetForfeited {
    pub market_id: Pubkey,
    pub bettor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PredictionMarketResolved {
    pub market_id: Pubkey,
    pub winning_project: String,
    pub total_pool: u64,
    pub winning_pool: u64,
    pub house_take: u64,
}

#[event]
pub struct PredictionWinningsClaimed {
    pub market_id: Pubkey,
    pub bettor: Pubkey,
    pub bet_amount: u64,
    pub winnings: u64,
    pub early_bird_discount_bps: u16,  // Basis points of fee discount (0-100 = 0-1%)
    pub fee_paid: u64,                 // Actual fee paid after early bird discount
}

#[event]
pub struct PredictionNoWinnerRefund {
    pub market_id: Pubkey,
    pub bettor: Pubkey,
    pub refund_amount: u64,
}

#[event]
pub struct PredictionMarketCancelled {
    pub market_id: Pubkey,
}

#[event]
pub struct PredictionRefundClaimed {
    pub market_id: Pubkey,
    pub bettor: Pubkey,
    pub refund_amount: u64,
}

// Memory Slots events

#[event]
pub struct MemoryPoolCreated {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub pull_price: u64,
    pub house_edge_bps: u16,
}

#[event]
pub struct MemoryDeposited {
    pub pool: Pubkey,
    pub memory: Pubkey,
    pub depositor: Pubkey,
    pub category: MemoryCategory,
    pub rarity: MemoryRarity,
    pub stake: u64,
}

#[event]
pub struct MemoryPulled {
    pub pool: Pubkey,
    pub memory: Pubkey,
    pub puller: Pubkey,
    pub depositor: Pubkey,
    pub content: String,
    pub pull_price: u64,
    pub depositor_share: u64,
    pub house_take: u64,
}

#[event]
pub struct MemoryRated {
    pub pool: Pubkey,
    pub memory: Pubkey,
    pub rater: Pubkey,
    pub depositor: Pubkey,
    pub rating: u8,
    pub stake_change: i64,  // Negative if depositor lost stake
}

#[event]
pub struct MemoryWithdrawn {
    pub pool: Pubkey,
    pub memory: Pubkey,
    pub depositor: Pubkey,
    pub refund: u64,
    pub fee: u64,
}

// === Hitman Market Events ===

#[event]
pub struct HitPoolInitialized {
    pub authority: Pubkey,
    pub house_edge_bps: u16,
}

#[event]
pub struct HitCreated {
    pub hit: Pubkey,
    pub poster: Pubkey,        // Pubkey::default() if anonymous
    pub target_description: String,
    pub condition: String,
    pub bounty: u64,
    pub anonymous: bool,
}

#[event]
pub struct HitClaimed {
    pub hit: Pubkey,
    pub hunter: Pubkey,
    pub claimed_at: i64,
}

#[event]
pub struct ProofSubmitted {
    pub hit: Pubkey,
    pub hunter: Pubkey,
    pub proof_link: String,
}

#[event]
pub struct HitCompleted {
    pub hit: Pubkey,
    pub hunter: Pubkey,
    pub payout: u64,
}

#[event]
pub struct HitDisputed {
    pub hit: Pubkey,
    pub poster: Pubkey,
}

#[event]
pub struct HitCancelled {
    pub hit: Pubkey,
    pub poster: Pubkey,
    pub refund: u64,
}

#[event]
pub struct ClaimExpired {
    pub hit: Pubkey,
    pub former_hunter: Pubkey,
    pub stake_forfeited: u64,
}

#[event]
pub struct ArbitrationVote {
    pub hit: Pubkey,
    pub arbiter: Pubkey,
    pub vote_approve: bool,
    pub votes_approve: u8,
    pub votes_reject: u8,
}

#[event]
pub struct ArbitrationResolved {
    pub hit: Pubkey,
    pub hunter_wins: bool,
    pub votes_approve: u8,
    pub votes_reject: u8,
}

// === Multi-Token Events ===

#[event]
pub struct TokenVaultInitialized {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub house_edge_bps: u16,
    pub min_bet: u64,
    pub max_bet_percent: u8,
}

#[event]
pub struct TokenLiquidityAdded {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub total_pool: u64,
}

#[event]
pub struct TokenGamePlayed {
    pub player: Pubkey,
    pub mint: Pubkey,
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

// === Switchboard VRF Events ===

#[event]
pub struct VrfRequestCreated {
    pub request: Pubkey,
    pub player: Pubkey,
    pub randomness_account: Pubkey,
    pub game_type: GameType,
    pub amount: u64,
    pub choice: u8,
}

#[event]
pub struct VrfRequestSettled {
    pub request: Pubkey,
    pub player: Pubkey,
    pub randomness: [u8; 32],
    pub result: u8,
    pub payout: u64,
    pub won: bool,
}

// === Pyth Price Prediction Events ===

#[event]
pub struct PricePredictionCreated {
    pub prediction: Pubkey,
    pub creator: Pubkey,
    pub asset: PriceAsset,
    pub target_price: i64,
    pub direction: PriceDirection,
    pub bet_amount: u64,
    pub expiry_time: i64,
}

#[event]
pub struct PricePredictionTaken {
    pub prediction: Pubkey,
    pub taker: Pubkey,
    pub total_pool: u64,
}

#[event]
pub struct PricePredictionSettled {
    pub prediction: Pubkey,
    pub settled_price: i64,
    pub target_price: i64,
    pub direction: PriceDirection,
    pub winner: Pubkey,
    pub payout: u64,
    pub house_take: u64,
}

#[event]
pub struct PricePredictionCancelled {
    pub prediction: Pubkey,
    pub creator: Pubkey,
    pub refund: u64,
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
    #[msg("Challenge is not open")]
    ChallengeNotOpen,
    #[msg("Cannot accept your own challenge")]
    CannotAcceptOwnChallenge,
    #[msg("Only the challenger can cancel")]
    NotChallengeOwner,
    #[msg("Invalid challenger account")]
    InvalidChallenger,
    // Prediction market errors
    #[msg("Question too long (max 200 chars)")]
    QuestionTooLong,
    #[msg("Close time must be in the future")]
    InvalidCloseTime,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Invalid project slug (1-50 chars)")]
    InvalidProjectSlug,
    #[msg("Betting has closed")]
    BettingClosed,
    #[msg("Only market authority can resolve")]
    NotMarketAuthority,
    #[msg("Market has not been resolved")]
    MarketNotResolved,
    #[msg("Market was not cancelled")]
    MarketNotCancelled,
    #[msg("Winnings already claimed")]
    AlreadyClaimed,
    #[msg("Your bet did not win")]
    DidNotWin,
    #[msg("Not the bet owner")]
    NotBetOwner,
    #[msg("Cannot change bet outcome after placing")]
    CannotChangeBetOutcome,
    // Commit-reveal errors
    #[msg("Reveal deadline must be after commit deadline")]
    RevealMustBeAfterCommit,
    #[msg("Market is not in commit phase")]
    NotInCommitPhase,
    #[msg("Commit phase has closed")]
    CommitPhaseClosed,
    #[msg("Commit phase has not ended yet")]
    CommitPhaseNotEnded,
    #[msg("Market is not in reveal phase")]
    NotInRevealPhase,
    #[msg("Reveal phase has closed")]
    RevealPhaseClosed,
    #[msg("Reveal phase has not ended yet")]
    RevealPhaseNotEnded,
    #[msg("Already committed a bet")]
    AlreadyCommitted,
    #[msg("Already revealed this bet")]
    AlreadyRevealed,
    #[msg("Invalid reveal - hash does not match commitment")]
    InvalidReveal,
    #[msg("Bet was not revealed")]
    BetNotRevealed,
    #[msg("No winning bets - cannot claim")]
    NoWinningBets,
    // Memory Slots errors
    #[msg("Memory content invalid (must be 1-500 chars)")]
    MemoryContentInvalid,
    #[msg("Memory is not active")]
    MemoryNotActive,
    #[msg("Memory pool mismatch")]
    MemoryPoolMismatch,
    #[msg("Memory has already been pulled")]
    MemoryAlreadyPulled,
    #[msg("Not the memory owner")]
    NotMemoryOwner,
    #[msg("Invalid depositor account")]
    InvalidDepositor,
    #[msg("Not the pull owner")]
    NotPullOwner,
    #[msg("Invalid rating (must be 1-5)")]
    InvalidRating,
    #[msg("Already rated this memory")]
    AlreadyRated,
    // Hitman Market errors
    #[msg("Hit description invalid (must be 10-200 chars)")]
    HitDescriptionInvalid,
    #[msg("Hit condition invalid (must be 10-500 chars)")]
    HitConditionInvalid,
    #[msg("Hit bounty too small (minimum 0.01 SOL)")]
    HitBountyTooSmall,
    #[msg("Hit is not open for claims")]
    HitNotOpen,
    #[msg("Cannot hunt your own hit")]
    CannotHuntOwnHit,
    #[msg("Hit has not been claimed")]
    HitNotClaimed,
    #[msg("Not the hunter for this hit")]
    NotTheHunter,
    #[msg("Proof link invalid (must be valid URL)")]
    ProofLinkInvalid,
    #[msg("Hit is not pending verification")]
    HitNotPendingVerification,
    #[msg("Not the hit poster")]
    NotHitPoster,
    #[msg("Claim has not expired yet")]
    ClaimNotExpired,
    #[msg("Hit is not in disputed state")]
    HitNotDisputed,
    #[msg("Already voted on this arbitration")]
    AlreadyVotedArbitration,
    #[msg("Arbitration panel is full")]
    ArbitrationFull,
    #[msg("Invalid arbiter")]
    InvalidArbiter,
    #[msg("Hit pool mismatch")]
    HitPoolMismatch,
    #[msg("Stake amount too low")]
    StakeTooLow,
    // Multi-token errors
    #[msg("Token vault not initialized for this mint")]
    TokenVaultNotInitialized,
    #[msg("Invalid token mint")]
    InvalidMint,
    #[msg("Token vault mismatch")]
    TokenVaultMismatch,
    #[msg("Insufficient token balance")]
    InsufficientTokenBalance,
    // Switchboard VRF errors
    #[msg("VRF request already settled")]
    VrfAlreadySettled,
    #[msg("VRF randomness not ready yet")]
    VrfRandomnessNotReady,
    #[msg("Invalid VRF randomness account")]
    VrfInvalidRandomness,
    // Price prediction errors
    #[msg("Price bet is not open")]
    PriceBetNotOpen,
    #[msg("Price bet already taken")]
    PriceBetAlreadyTaken,
    #[msg("Price bet not matched")]
    PriceBetNotMatched,
    #[msg("Price bet not yet expired")]
    PriceBetNotExpired,
    #[msg("Price bet has expired")]
    PriceBetExpired,
    #[msg("Not the price bet creator")]
    NotPriceBetCreator,
    #[msg("Cannot take your own bet")]
    CannotTakeOwnBet,
    #[msg("Invalid duration (must be 1 min to 7 days)")]
    InvalidDuration,
    #[msg("Invalid target price")]
    InvalidTargetPrice,
    #[msg("Invalid price feed account")]
    InvalidPriceFeed,
    #[msg("Price feed is stale")]
    PriceFeedStale,
    #[msg("Invalid creator account")]
    InvalidCreatorAccount,
    #[msg("Invalid taker account")]
    InvalidTakerAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
