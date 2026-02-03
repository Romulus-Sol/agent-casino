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
        let total_pot = amount.checked_mul(2).unwrap();
        let house_edge = ctx.accounts.house.house_edge_bps;
        let house_take = total_pot * house_edge as u64 / 10000;
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
        house.total_games += 1;
        house.total_volume = house.total_volume.checked_add(total_pot).unwrap();
        house.pool = house.pool.checked_add(house_take).unwrap();

        // Update challenger stats
        let challenger_stats = &mut ctx.accounts.challenger_stats;
        if challenger_stats.agent == Pubkey::default() {
            challenger_stats.agent = ctx.accounts.challenger.key();
        }
        challenger_stats.total_games += 1;
        challenger_stats.total_wagered = challenger_stats.total_wagered.checked_add(amount).unwrap();
        challenger_stats.pvp_games = challenger_stats.pvp_games.checked_add(1).unwrap_or(challenger_stats.pvp_games);
        if challenger_won {
            challenger_stats.total_won = challenger_stats.total_won.checked_add(winner_payout).unwrap();
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
        acceptor_stats.total_games += 1;
        acceptor_stats.total_wagered = acceptor_stats.total_wagered.checked_add(amount).unwrap();
        acceptor_stats.pvp_games = acceptor_stats.pvp_games.checked_add(1).unwrap_or(acceptor_stats.pvp_games);
        if !challenger_won {
            acceptor_stats.total_won = acceptor_stats.total_won.checked_add(winner_payout).unwrap();
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

    /// Create a new prediction market
    /// question: Short description (e.g., "Which project wins 1st place?")
    /// outcomes: Array of outcome names (e.g., ["agent-casino", "clawverse", "sipher"])
    /// closes_at: Unix timestamp when betting closes
    pub fn create_prediction_market(
        ctx: Context<CreatePredictionMarket>,
        market_id: u64,
        question: String,
        outcomes: Vec<String>,
        closes_at: i64,
    ) -> Result<()> {
        require!(outcomes.len() >= 2 && outcomes.len() <= 10, CasinoError::InvalidOutcomeCount);
        require!(question.len() <= 200, CasinoError::QuestionTooLong);
        for outcome in &outcomes {
            require!(outcome.len() <= 32, CasinoError::OutcomeNameTooLong);
        }

        let clock = Clock::get()?;
        require!(closes_at > clock.unix_timestamp, CasinoError::InvalidCloseTime);

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.market_id = market_id;
        market.question = question.clone();
        market.outcome_count = outcomes.len() as u8;
        market.status = MarketStatus::Open;
        market.winning_outcome = 0;
        market.total_pool = 0;
        market.closes_at = closes_at;
        market.resolved_at = 0;
        market.created_at = clock.unix_timestamp;
        market.bump = ctx.bumps.market;

        // Initialize outcome pools (up to 10 outcomes)
        market.outcome_pools = [0u64; 10];

        // Store outcome names
        let mut outcome_names = [[0u8; 32]; 10];
        for (i, name) in outcomes.iter().enumerate() {
            let bytes = name.as_bytes();
            outcome_names[i][..bytes.len()].copy_from_slice(bytes);
        }
        market.outcome_names = outcome_names;

        emit!(PredictionMarketCreated {
            market_id: ctx.accounts.market.key(),
            authority: ctx.accounts.authority.key(),
            question,
            outcome_count: outcomes.len() as u8,
            closes_at,
        });

        Ok(())
    }

    /// Place a bet on a prediction market outcome
    pub fn place_prediction_bet(
        ctx: Context<PlacePredictionBet>,
        outcome_index: u8,
        amount: u64,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Open, CasinoError::MarketNotOpen);
        require!(outcome_index < market.outcome_count, CasinoError::InvalidOutcome);
        require!(amount > 0, CasinoError::InvalidAmount);

        let clock = Clock::get()?;
        require!(clock.unix_timestamp < market.closes_at, CasinoError::BettingClosed);

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

        // Update market pools
        let market = &mut ctx.accounts.market;
        market.outcome_pools[outcome_index as usize] = market.outcome_pools[outcome_index as usize]
            .checked_add(amount)
            .unwrap();
        market.total_pool = market.total_pool.checked_add(amount).unwrap();

        let outcome_pool = market.outcome_pools[outcome_index as usize];
        let total_pool = market.total_pool;

        // Initialize or update bet record
        let bet = &mut ctx.accounts.bet;
        if bet.bettor == Pubkey::default() {
            bet.bettor = bettor_key;
            bet.market = market_key;
            bet.outcome_index = outcome_index;
            bet.amount = amount;
            bet.claimed = false;
            bet.bump = ctx.bumps.bet;
        } else {
            // Adding to existing bet on same outcome
            require!(bet.outcome_index == outcome_index, CasinoError::CannotChangeBetOutcome);
            bet.amount = bet.amount.checked_add(amount).unwrap();
        }

        let total_bet = bet.amount;

        emit!(PredictionBetPlaced {
            market_id: market_key,
            bettor: bettor_key,
            outcome_index,
            amount,
            total_bet,
            outcome_pool,
            total_pool,
        });

        Ok(())
    }

    /// Resolve a prediction market (authority only)
    pub fn resolve_prediction_market(
        ctx: Context<ResolvePredictionMarket>,
        winning_outcome: u8,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Open, CasinoError::MarketNotOpen);
        require!(winning_outcome < market.outcome_count, CasinoError::InvalidOutcome);
        require!(
            ctx.accounts.authority.key() == market.authority,
            CasinoError::NotMarketAuthority
        );

        // Capture values before mutable borrow
        let market_key = ctx.accounts.market.key();
        let total_pool = market.total_pool;
        let winning_pool = market.outcome_pools[winning_outcome as usize];
        let clock = Clock::get()?;

        // Calculate house take (from total pool)
        let house_edge = ctx.accounts.house.house_edge_bps;
        let house_take = total_pool * house_edge as u64 / 10000;

        // Transfer house take
        if house_take > 0 {
            **ctx.accounts.market.to_account_info().try_borrow_mut_lamports()? -= house_take;
            **ctx.accounts.house.to_account_info().try_borrow_mut_lamports()? += house_take;
        }

        // Update house stats
        let house = &mut ctx.accounts.house;
        house.total_volume = house.total_volume.checked_add(total_pool).unwrap();
        house.pool = house.pool.checked_add(house_take).unwrap();

        // Update market state
        let market = &mut ctx.accounts.market;
        market.status = MarketStatus::Resolved;
        market.winning_outcome = winning_outcome;
        market.resolved_at = clock.unix_timestamp;

        emit!(PredictionMarketResolved {
            market_id: market_key,
            winning_outcome,
            total_pool,
            winning_pool,
            house_take,
        });

        Ok(())
    }

    /// Claim winnings from a resolved prediction market
    pub fn claim_prediction_winnings(ctx: Context<ClaimPredictionWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let bet = &ctx.accounts.bet;

        require!(market.status == MarketStatus::Resolved, CasinoError::MarketNotResolved);
        require!(!bet.claimed, CasinoError::AlreadyClaimed);
        require!(bet.outcome_index == market.winning_outcome, CasinoError::DidNotWin);

        // Calculate winnings: (bet_amount / winning_pool) * (total_pool - house_take)
        let winning_pool = market.outcome_pools[market.winning_outcome as usize];
        let house_take = market.total_pool * ctx.accounts.house.house_edge_bps as u64 / 10000;
        let payout_pool = market.total_pool - house_take;

        let winnings = (bet.amount as u128)
            .checked_mul(payout_pool as u128)
            .unwrap()
            .checked_div(winning_pool as u128)
            .unwrap() as u64;

        // Transfer winnings
        **ctx.accounts.market.to_account_info().try_borrow_mut_lamports()? -= winnings;
        **ctx.accounts.bettor.to_account_info().try_borrow_mut_lamports()? += winnings;

        // Mark as claimed
        let bet = &mut ctx.accounts.bet;
        bet.claimed = true;

        // Update agent stats
        let agent_stats = &mut ctx.accounts.agent_stats;
        if agent_stats.agent == Pubkey::default() {
            agent_stats.agent = ctx.accounts.bettor.key();
            agent_stats.bump = ctx.bumps.agent_stats;
        }
        agent_stats.total_won = agent_stats.total_won.checked_add(winnings).unwrap();
        agent_stats.wins += 1;

        emit!(PredictionWinningsClaimed {
            market_id: ctx.accounts.market.key(),
            bettor: ctx.accounts.bettor.key(),
            bet_amount: bet.amount,
            winnings,
        });

        Ok(())
    }

    /// Cancel an open prediction market and refund all bettors (authority only)
    pub fn cancel_prediction_market(ctx: Context<CancelPredictionMarket>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Open, CasinoError::MarketNotOpen);
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
#[instruction(market_id: u64, question: String, outcomes: Vec<String>, closes_at: i64)]
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

#[derive(Accounts)]
#[instruction(outcome_index: u8, amount: u64)]
pub struct PlacePredictionBet<'info> {
    #[account(seeds = [b"house"], bump = house.bump)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        constraint = market.status == MarketStatus::Open @ CasinoError::MarketNotOpen
    )]
    pub market: Account<'info, PredictionMarket>,

    #[account(
        init_if_needed,
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
    #[account(seeds = [b"house"], bump = house.bump)]
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
        constraint = market.authority == authority.key() @ CasinoError::NotMarketAuthority,
        constraint = market.status == MarketStatus::Open @ CasinoError::MarketNotOpen
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
    #[max_len(200)]
    pub question: String,
    pub outcome_count: u8,
    pub outcome_names: [[u8; 32]; 10],  // Up to 10 outcomes, 32 bytes each
    pub outcome_pools: [u64; 10],        // Pool for each outcome
    pub total_pool: u64,
    pub status: MarketStatus,
    pub winning_outcome: u8,
    pub closes_at: i64,
    pub resolved_at: i64,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PredictionBet {
    pub bettor: Pubkey,
    pub market: Pubkey,
    pub outcome_index: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

// === Types ===

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum GameType {
    CoinFlip,
    DiceRoll,
    Limbo,
    PvPChallenge,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ChallengeStatus {
    Open,
    Completed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Open,
    Resolved,
    Cancelled,
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
    pub outcome_count: u8,
    pub closes_at: i64,
}

#[event]
pub struct PredictionBetPlaced {
    pub market_id: Pubkey,
    pub bettor: Pubkey,
    pub outcome_index: u8,
    pub amount: u64,
    pub total_bet: u64,
    pub outcome_pool: u64,
    pub total_pool: u64,
}

#[event]
pub struct PredictionMarketResolved {
    pub market_id: Pubkey,
    pub winning_outcome: u8,
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
    #[msg("Must have 2-10 outcomes")]
    InvalidOutcomeCount,
    #[msg("Question too long (max 200 chars)")]
    QuestionTooLong,
    #[msg("Outcome name too long (max 32 chars)")]
    OutcomeNameTooLong,
    #[msg("Close time must be in the future")]
    InvalidCloseTime,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Invalid outcome index")]
    InvalidOutcome,
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
}
