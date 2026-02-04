//! CPI (Cross-Program Invocation) helpers for Agent Casino
//!
//! This module provides helper functions for other Solana programs to call
//! Agent Casino instructions via CPI.
//!
//! # Example
//!
//! ```ignore
//! use agent_casino::cpi;
//! use agent_casino::cpi::accounts::CoinFlip;
//!
//! // In your program's instruction handler:
//! let cpi_accounts = CoinFlip {
//!     house: ctx.accounts.house.to_account_info(),
//!     house_vault: ctx.accounts.house_vault.to_account_info(),
//!     game_record: ctx.accounts.game_record.to_account_info(),
//!     agent_stats: ctx.accounts.agent_stats.to_account_info(),
//!     player: ctx.accounts.player.to_account_info(),
//!     system_program: ctx.accounts.system_program.to_account_info(),
//! };
//!
//! let cpi_ctx = CpiContext::new(ctx.accounts.casino_program.to_account_info(), cpi_accounts);
//! agent_casino::cpi::coin_flip(cpi_ctx, amount, choice, client_seed)?;
//! ```

use anchor_lang::prelude::*;

/// Account struct for CPI coin flip calls
#[derive(Accounts)]
pub struct CpiCoinFlip<'info> {
    /// CHECK: House account (validated by casino program)
    pub house: AccountInfo<'info>,
    /// CHECK: House vault (validated by casino program)
    pub house_vault: AccountInfo<'info>,
    /// CHECK: Game record to be created (validated by casino program)
    pub game_record: AccountInfo<'info>,
    /// CHECK: Agent stats (validated by casino program)
    pub agent_stats: AccountInfo<'info>,
    /// CHECK: Player/signer
    pub player: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

/// Account struct for CPI dice roll calls
#[derive(Accounts)]
pub struct CpiDiceRoll<'info> {
    /// CHECK: House account
    pub house: AccountInfo<'info>,
    /// CHECK: House vault
    pub house_vault: AccountInfo<'info>,
    /// CHECK: Game record to be created
    pub game_record: AccountInfo<'info>,
    /// CHECK: Agent stats
    pub agent_stats: AccountInfo<'info>,
    /// CHECK: Player/signer
    pub player: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

/// Account struct for CPI limbo calls
#[derive(Accounts)]
pub struct CpiLimbo<'info> {
    /// CHECK: House account
    pub house: AccountInfo<'info>,
    /// CHECK: House vault
    pub house_vault: AccountInfo<'info>,
    /// CHECK: Game record to be created
    pub game_record: AccountInfo<'info>,
    /// CHECK: Agent stats
    pub agent_stats: AccountInfo<'info>,
    /// CHECK: Player/signer
    pub player: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

/// Account struct for CPI add liquidity calls
#[derive(Accounts)]
pub struct CpiAddLiquidity<'info> {
    /// CHECK: House account
    pub house: AccountInfo<'info>,
    /// CHECK: House vault
    pub house_vault: AccountInfo<'info>,
    /// CHECK: LP position
    pub lp_position: AccountInfo<'info>,
    /// CHECK: Provider/signer
    pub provider: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

/// Account struct for CPI create challenge calls
#[derive(Accounts)]
pub struct CpiCreateChallenge<'info> {
    /// CHECK: House account
    pub house: AccountInfo<'info>,
    /// CHECK: Challenge account to be created
    pub challenge: AccountInfo<'info>,
    /// CHECK: Challenger/signer
    pub challenger: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

/// Account struct for CPI accept challenge calls
#[derive(Accounts)]
pub struct CpiAcceptChallenge<'info> {
    /// CHECK: House account
    pub house: AccountInfo<'info>,
    /// CHECK: Challenge account
    pub challenge: AccountInfo<'info>,
    /// CHECK: Original challenger
    pub challenger: AccountInfo<'info>,
    /// CHECK: Challenger stats
    pub challenger_stats: AccountInfo<'info>,
    /// CHECK: Acceptor stats
    pub acceptor_stats: AccountInfo<'info>,
    /// CHECK: Acceptor/signer
    pub acceptor: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

/// Account struct for CPI memory deposit calls
#[derive(Accounts)]
pub struct CpiDepositMemory<'info> {
    /// CHECK: Memory pool
    pub memory_pool: AccountInfo<'info>,
    /// CHECK: Memory account to be created
    pub memory: AccountInfo<'info>,
    /// CHECK: Depositor/signer
    pub depositor: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

/// Account struct for CPI memory pull calls
#[derive(Accounts)]
pub struct CpiPullMemory<'info> {
    /// CHECK: House account
    pub house: AccountInfo<'info>,
    /// CHECK: Memory pool
    pub memory_pool: AccountInfo<'info>,
    /// CHECK: Memory account
    pub memory: AccountInfo<'info>,
    /// CHECK: Memory depositor
    pub depositor: AccountInfo<'info>,
    /// CHECK: Pull record to be created
    pub pull_record: AccountInfo<'info>,
    /// CHECK: Puller/signer
    pub puller: AccountInfo<'info>,
    /// CHECK: System program
    pub system_program: AccountInfo<'info>,
}

/// Derive the house PDA address
pub fn derive_house_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"house"], program_id)
}

/// Derive the vault PDA address
pub fn derive_vault_pda(house: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", house.as_ref()], program_id)
}

/// Derive the game record PDA address
pub fn derive_game_record_pda(house: &Pubkey, game_index: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"game", house.as_ref(), &game_index.to_le_bytes()],
        program_id,
    )
}

/// Derive the agent stats PDA address
pub fn derive_agent_stats_pda(agent: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"agent", agent.as_ref()], program_id)
}

/// Derive the LP position PDA address
pub fn derive_lp_position_pda(house: &Pubkey, provider: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"lp", house.as_ref(), provider.as_ref()], program_id)
}

/// Derive the challenge PDA address
pub fn derive_challenge_pda(challenger: &Pubkey, nonce: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"challenge", challenger.as_ref(), &nonce.to_le_bytes()],
        program_id,
    )
}

/// Derive the memory pool PDA address
pub fn derive_memory_pool_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"memory_pool"], program_id)
}

/// Derive the memory PDA address
pub fn derive_memory_pda(pool: &Pubkey, index: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"memory", pool.as_ref(), &index.to_le_bytes()],
        program_id,
    )
}

/// Derive the memory pull record PDA address
pub fn derive_memory_pull_pda(memory: &Pubkey, puller: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"mem_pull", memory.as_ref(), puller.as_ref()], program_id)
}

/// Derive the prediction market PDA address
pub fn derive_prediction_market_pda(market_id: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"pred_mkt", &market_id.to_le_bytes()], program_id)
}

/// Derive the prediction bet PDA address
pub fn derive_prediction_bet_pda(market: &Pubkey, bettor: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"pred_bet", market.as_ref(), bettor.as_ref()], program_id)
}

// === Multi-Token PDA Derivations ===

/// Derive the token vault PDA address
pub fn derive_token_vault_pda(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"token_vault", mint.as_ref()], program_id)
}

/// Derive the token vault ATA PDA address
pub fn derive_token_vault_ata_pda(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"token_vault_ata", mint.as_ref()], program_id)
}

/// Derive the token LP position PDA address
pub fn derive_token_lp_position_pda(vault: &Pubkey, provider: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"token_lp", vault.as_ref(), provider.as_ref()], program_id)
}

/// Derive the token game record PDA address
pub fn derive_token_game_record_pda(vault: &Pubkey, game_index: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"token_game", vault.as_ref(), &game_index.to_le_bytes()],
        program_id,
    )
}

// === Switchboard VRF PDA Derivations ===

/// Derive the VRF request PDA address
pub fn derive_vrf_request_pda(player: &Pubkey, game_index: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"vrf_request", player.as_ref(), &game_index.to_le_bytes()],
        program_id,
    )
}

// === Pyth Price Prediction PDA Derivations ===

/// Derive the price prediction PDA address
pub fn derive_price_prediction_pda(house: &Pubkey, bet_index: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"price_bet", house.as_ref(), &bet_index.to_le_bytes()],
        program_id,
    )
}
