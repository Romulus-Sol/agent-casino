use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    system_program,
    transaction::Transaction,
};

/// Program ID matching declare_id! in lib.rs
const PROGRAM_ID_BYTES: &str = "5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV";

fn program_id() -> Pubkey {
    PROGRAM_ID_BYTES.parse().unwrap()
}

/// Compute Anchor 8-byte instruction discriminator: sha256("global:<name>")[..8]
fn anchor_discriminator(name: &str) -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(format!("global:{}", name).as_bytes());
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Find PDA for given seeds
fn find_pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &program_id())
}

/// Create a ProgramTest instance with our program loaded
fn program_test() -> ProgramTest {
    let mut pt = ProgramTest::new(
        "agent_casino",
        program_id(),
        None, // Use BPF loader — loads from target/deploy/
    );
    pt.prefer_bpf(true);
    pt
}

// === Instruction Builders ===

fn ix_initialize_house(
    authority: &Pubkey,
    house_edge_bps: u16,
    min_bet: u64,
    max_bet_percent: u8,
) -> Instruction {
    let (house_pda, _) = find_pda(&[b"house"]);
    let (vault_pda, _) = find_pda(&[b"vault", house_pda.as_ref()]);

    let mut data = anchor_discriminator("initialize_house").to_vec();
    data.extend_from_slice(&house_edge_bps.to_le_bytes());
    data.extend_from_slice(&min_bet.to_le_bytes());
    data.push(max_bet_percent);

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(house_pda, false),
            AccountMeta::new_readonly(vault_pda, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

fn ix_init_lp_position(provider: &Pubkey) -> Instruction {
    let (house_pda, _) = find_pda(&[b"house"]);
    let (lp_pda, _) = find_pda(&[b"lp", house_pda.as_ref(), provider.as_ref()]);

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(house_pda, false),
            AccountMeta::new(lp_pda, false),
            AccountMeta::new(*provider, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: anchor_discriminator("init_lp_position").to_vec(),
    }
}

fn ix_add_liquidity(provider: &Pubkey, amount: u64) -> Instruction {
    let (house_pda, _) = find_pda(&[b"house"]);
    let (vault_pda, _) = find_pda(&[b"vault", house_pda.as_ref()]);
    let (lp_pda, _) = find_pda(&[b"lp", house_pda.as_ref(), provider.as_ref()]);

    let mut data = anchor_discriminator("add_liquidity").to_vec();
    data.extend_from_slice(&amount.to_le_bytes());

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(house_pda, false),
            AccountMeta::new(vault_pda, false),
            AccountMeta::new(lp_pda, false),
            AccountMeta::new(*provider, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

fn ix_remove_liquidity(provider: &Pubkey, amount: u64) -> Instruction {
    let (house_pda, _) = find_pda(&[b"house"]);
    let (lp_pda, _) = find_pda(&[b"lp", house_pda.as_ref(), provider.as_ref()]);

    let mut data = anchor_discriminator("remove_liquidity").to_vec();
    data.extend_from_slice(&amount.to_le_bytes());

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(house_pda, false),
            AccountMeta::new(lp_pda, false),
            AccountMeta::new(*provider, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

fn ix_init_agent_stats(player: &Pubkey) -> Instruction {
    let (agent_stats_pda, _) = find_pda(&[b"agent", player.as_ref()]);

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(agent_stats_pda, false),
            AccountMeta::new(*player, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: anchor_discriminator("init_agent_stats").to_vec(),
    }
}

fn ix_create_memory_pool(authority: &Pubkey, pull_price: u64, house_edge_bps: u16) -> Instruction {
    let (memory_pool_pda, _) = find_pda(&[b"memory_pool"]);

    let mut data = anchor_discriminator("create_memory_pool").to_vec();
    data.extend_from_slice(&pull_price.to_le_bytes());
    data.extend_from_slice(&house_edge_bps.to_le_bytes());

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(memory_pool_pda, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

fn ix_vrf_coin_flip_request(
    player: &Pubkey,
    randomness_account: &Pubkey,
    game_index: u64,
    amount: u64,
    choice: u8,
) -> Instruction {
    let (house_pda, _) = find_pda(&[b"house"]);
    let (vrf_request_pda, _) = find_pda(&[
        b"vrf_request",
        player.as_ref(),
        &game_index.to_le_bytes(),
    ]);

    let mut data = anchor_discriminator("vrf_coin_flip_request").to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(choice);

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(house_pda, false),
            AccountMeta::new(vrf_request_pda, false),
            AccountMeta::new_readonly(*randomness_account, false),
            AccountMeta::new(*player, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

// === Helper to send tx and check result ===

async fn send_tx(
    banks: &mut BanksClient,
    payer: &Keypair,
    ixs: &[Instruction],
    signers: &[&Keypair],
    recent_blockhash: solana_sdk::hash::Hash,
) -> Result<(), BanksClientError> {
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&payer.pubkey()),
        signers,
        recent_blockhash,
    );
    banks.process_transaction(tx).await
}

// ==================== TESTS ====================

#[tokio::test]
async fn test_initialize_house() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    let result = send_tx(
        &mut banks,
        &payer,
        &[ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 5)],
        &[&payer],
        recent_blockhash,
    ).await;

    assert!(result.is_ok(), "initialize_house failed: {:?}", result.err());

    // Verify house PDA exists and has correct data
    let (house_pda, _) = find_pda(&[b"house"]);
    let account = banks.get_account(house_pda).await.unwrap().unwrap();
    assert_eq!(account.owner, program_id());

    // Verify authority (offset 8, 32 bytes)
    let stored_authority = Pubkey::try_from(&account.data[8..40]).unwrap();
    assert_eq!(stored_authority, payer.pubkey());

    // Verify pool is 0 (offset 40, u64)
    let pool = u64::from_le_bytes(account.data[40..48].try_into().unwrap());
    assert_eq!(pool, 0);

    // Verify house edge = 100 (offset 48, u16)
    let edge = u16::from_le_bytes(account.data[48..50].try_into().unwrap());
    assert_eq!(edge, 100);
}

#[tokio::test]
async fn test_initialize_house_invalid_edge() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    // Edge > 1000 should fail
    let result = send_tx(
        &mut banks,
        &payer,
        &[ix_initialize_house(&payer.pubkey(), 1500, 10_000_000, 5)],
        &[&payer],
        recent_blockhash,
    ).await;

    assert!(result.is_err(), "Edge > 1000 should be rejected");
}

#[tokio::test]
async fn test_initialize_house_invalid_max_bet() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    // max_bet_percent > 10 should fail
    let result = send_tx(
        &mut banks,
        &payer,
        &[ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 15)],
        &[&payer],
        recent_blockhash,
    ).await;

    assert!(result.is_err(), "max_bet_percent > 10 should be rejected");
}

#[tokio::test]
async fn test_add_liquidity() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    // Init house + LP
    send_tx(
        &mut banks, &payer,
        &[
            ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 5),
            ix_init_lp_position(&payer.pubkey()),
        ],
        &[&payer],
        recent_blockhash,
    ).await.unwrap();

    // Add 1 SOL liquidity
    let amount = 1_000_000_000u64;
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &payer,
        &[ix_add_liquidity(&payer.pubkey(), amount)],
        &[&payer],
        blockhash,
    ).await.unwrap();

    // Verify pool increased
    let (house_pda, _) = find_pda(&[b"house"]);
    let account = banks.get_account(house_pda).await.unwrap().unwrap();
    let pool = u64::from_le_bytes(account.data[40..48].try_into().unwrap());
    assert_eq!(pool, amount);
}

#[tokio::test]
async fn test_remove_liquidity() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    // Init + add 2 SOL
    send_tx(
        &mut banks, &payer,
        &[
            ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 5),
            ix_init_lp_position(&payer.pubkey()),
        ],
        &[&payer],
        recent_blockhash,
    ).await.unwrap();

    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &payer,
        &[ix_add_liquidity(&payer.pubkey(), 2_000_000_000)],
        &[&payer],
        blockhash,
    ).await.unwrap();

    // Remove 1 SOL
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &payer,
        &[ix_remove_liquidity(&payer.pubkey(), 1_000_000_000)],
        &[&payer],
        blockhash,
    ).await.unwrap();

    // Pool should be 1 SOL
    let (house_pda, _) = find_pda(&[b"house"]);
    let account = banks.get_account(house_pda).await.unwrap().unwrap();
    let pool = u64::from_le_bytes(account.data[40..48].try_into().unwrap());
    assert_eq!(pool, 1_000_000_000);
}

#[tokio::test]
async fn test_remove_liquidity_non_authority_fails() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    // Init as payer (authority)
    send_tx(
        &mut banks, &payer,
        &[
            ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 5),
            ix_init_lp_position(&payer.pubkey()),
        ],
        &[&payer],
        recent_blockhash,
    ).await.unwrap();

    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &payer,
        &[ix_add_liquidity(&payer.pubkey(), 2_000_000_000)],
        &[&payer],
        blockhash,
    ).await.unwrap();

    // Attacker tries to remove
    let attacker = Keypair::new();
    // Airdrop to attacker (transfer from payer)
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    let transfer_ix = solana_sdk::system_instruction::transfer(
        &payer.pubkey(),
        &attacker.pubkey(),
        500_000_000,
    );
    send_tx(&mut banks, &payer, &[transfer_ix], &[&payer], blockhash).await.unwrap();

    // Init attacker's LP
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &attacker,
        &[ix_init_lp_position(&attacker.pubkey())],
        &[&attacker],
        blockhash,
    ).await.unwrap();

    // Attacker tries to remove — should fail (not authority)
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    let result = send_tx(
        &mut banks, &attacker,
        &[ix_remove_liquidity(&attacker.pubkey(), 1_000_000_000)],
        &[&attacker],
        blockhash,
    ).await;

    assert!(result.is_err(), "Non-authority should not be able to remove liquidity");
}

#[tokio::test]
async fn test_init_agent_stats() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    // Init house
    send_tx(
        &mut banks, &payer,
        &[ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 5)],
        &[&payer],
        recent_blockhash,
    ).await.unwrap();

    // Init player stats
    let player = Keypair::new();
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    let transfer_ix = solana_sdk::system_instruction::transfer(
        &payer.pubkey(),
        &player.pubkey(),
        500_000_000,
    );
    send_tx(&mut banks, &payer, &[transfer_ix], &[&payer], blockhash).await.unwrap();

    let blockhash = banks.get_latest_blockhash().await.unwrap();
    let result = send_tx(
        &mut banks, &player,
        &[ix_init_agent_stats(&player.pubkey())],
        &[&player],
        blockhash,
    ).await;

    assert!(result.is_ok(), "init_agent_stats failed: {:?}", result.err());

    // Verify PDA
    let (stats_pda, _) = find_pda(&[b"agent", player.pubkey().as_ref()]);
    let account = banks.get_account(stats_pda).await.unwrap().unwrap();
    let stored_agent = Pubkey::try_from(&account.data[8..40]).unwrap();
    assert_eq!(stored_agent, player.pubkey());
}

#[tokio::test]
async fn test_create_memory_pool() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    let pull_price = 20_000_000u64;
    let result = send_tx(
        &mut banks, &payer,
        &[ix_create_memory_pool(&payer.pubkey(), pull_price, 1000)],
        &[&payer],
        recent_blockhash,
    ).await;

    assert!(result.is_ok(), "create_memory_pool failed: {:?}", result.err());

    let (pool_pda, _) = find_pda(&[b"memory_pool"]);
    let account = banks.get_account(pool_pda).await.unwrap().unwrap();
    let stored_authority = Pubkey::try_from(&account.data[8..40]).unwrap();
    assert_eq!(stored_authority, payer.pubkey());
    let stored_price = u64::from_le_bytes(account.data[40..48].try_into().unwrap());
    assert_eq!(stored_price, pull_price);
}

#[tokio::test]
async fn test_bet_too_small() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    // Init house with min_bet = 0.01 SOL
    send_tx(
        &mut banks, &payer,
        &[
            ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 5),
            ix_init_lp_position(&payer.pubkey()),
        ],
        &[&payer],
        recent_blockhash,
    ).await.unwrap();

    // Add 5 SOL liquidity
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &payer,
        &[ix_add_liquidity(&payer.pubkey(), 5_000_000_000)],
        &[&payer],
        blockhash,
    ).await.unwrap();

    // Create player
    let player = Keypair::new();
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &payer,
        &[solana_sdk::system_instruction::transfer(&payer.pubkey(), &player.pubkey(), 1_000_000_000)],
        &[&payer],
        blockhash,
    ).await.unwrap();

    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &player,
        &[ix_init_agent_stats(&player.pubkey())],
        &[&player],
        blockhash,
    ).await.unwrap();

    // Bet below min_bet
    let randomness = Keypair::new();
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    let result = send_tx(
        &mut banks, &player,
        &[ix_vrf_coin_flip_request(&player.pubkey(), &randomness.pubkey(), 0, 1_000_000, 0)],
        &[&player],
        blockhash,
    ).await;

    assert!(result.is_err(), "Bet below min_bet should be rejected");
}

#[tokio::test]
async fn test_bet_too_large() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    // Init house: 5% max bet
    send_tx(
        &mut banks, &payer,
        &[
            ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 5),
            ix_init_lp_position(&payer.pubkey()),
        ],
        &[&payer],
        recent_blockhash,
    ).await.unwrap();

    // Add 1 SOL → max bet = 0.05 SOL
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &payer,
        &[ix_add_liquidity(&payer.pubkey(), 1_000_000_000)],
        &[&payer],
        blockhash,
    ).await.unwrap();

    let player = Keypair::new();
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &payer,
        &[solana_sdk::system_instruction::transfer(&payer.pubkey(), &player.pubkey(), 1_000_000_000)],
        &[&payer],
        blockhash,
    ).await.unwrap();

    let blockhash = banks.get_latest_blockhash().await.unwrap();
    send_tx(
        &mut banks, &player,
        &[ix_init_agent_stats(&player.pubkey())],
        &[&player],
        blockhash,
    ).await.unwrap();

    // Bet 0.1 SOL > max bet (5% of 1 SOL = 0.05)
    let randomness = Keypair::new();
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    let result = send_tx(
        &mut banks, &player,
        &[ix_vrf_coin_flip_request(&player.pubkey(), &randomness.pubkey(), 0, 100_000_000, 1)],
        &[&player],
        blockhash,
    ).await;

    assert!(result.is_err(), "Bet above max_bet should be rejected");
}

#[tokio::test]
async fn test_add_liquidity_zero_fails() {
    let pt = program_test();
    let (mut banks, payer, recent_blockhash) = pt.start().await;

    send_tx(
        &mut banks, &payer,
        &[
            ix_initialize_house(&payer.pubkey(), 100, 10_000_000, 5),
            ix_init_lp_position(&payer.pubkey()),
        ],
        &[&payer],
        recent_blockhash,
    ).await.unwrap();

    let blockhash = banks.get_latest_blockhash().await.unwrap();
    let result = send_tx(
        &mut banks, &payer,
        &[ix_add_liquidity(&payer.pubkey(), 0)],
        &[&payer],
        blockhash,
    ).await;

    assert!(result.is_err(), "Adding 0 liquidity should fail");
}
