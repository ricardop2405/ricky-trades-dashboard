use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

declare_id!("11111111111111111111111111111111"); // Replace after `anchor keys list`

/// Atomic cross-platform prediction market arbitrage.
///
/// Executes TWO legs in a single transaction:
///   1. CPI into Triad `place_bid_order` (aggressive limit = taker fill)
///   2. CPI into Jupiter Predict buy order
///
/// After BOTH CPIs, asserts that the user received outcome tokens from BOTH
/// platforms. If either assertion fails → entire transaction reverts →
/// zero capital at risk.
#[program]
pub mod atomic_arb {
    use super::*;

    /// Execute an atomic cross-platform arb.
    ///
    /// `triad_amount_raw`  — USDC amount for Triad leg (6 decimals)
    /// `triad_price_raw`   — price per share for Triad (6 decimals, max 999_999)
    /// `triad_market_id`   — Triad market numeric ID
    /// `triad_direction`   — 0 = Hype (Up/YES), 1 = Flop (Down/NO)
    /// `min_triad_tokens`  — minimum outcome tokens expected from Triad fill
    /// `jup_data`          — raw instruction data for Jupiter order (pre-serialized)
    /// `min_jup_tokens`    — minimum outcome tokens expected from Jupiter fill
    pub fn execute_arb(
        ctx: Context<ExecuteArb>,
        triad_amount_raw: u64,
        triad_price_raw: u64,
        triad_market_id: u64,
        triad_direction: u8,
        min_triad_tokens: u64,
        jup_data: Vec<u8>,
        min_jup_tokens: u64,
    ) -> Result<()> {
        // ── Snapshot pre-balances ──
        let triad_tokens_before = ctx.accounts.user_triad_outcome_ata.amount;
        let jup_tokens_before = ctx.accounts.user_jup_outcome_ata.amount;

        msg!(
            "AtomicArb: triad_before={}, jup_before={}, triad_amt={}, jup_data_len={}",
            triad_tokens_before,
            jup_tokens_before,
            triad_amount_raw,
            jup_data.len()
        );

        // ── Leg 1: CPI into Triad place_bid_order ──
        {
            // Discriminator: sha256("global:place_bid_order")[0..8]
            let disc: [u8; 8] = [154, 143, 199, 233, 97, 23, 223, 255];

            // Serialize PlaceBidOrderArgs: amount(u64) + price(u64) + market_id(u64) + direction(u8)
            let mut data = Vec::with_capacity(8 + 25);
            data.extend_from_slice(&disc);
            data.extend_from_slice(&triad_amount_raw.to_le_bytes());
            data.extend_from_slice(&triad_price_raw.to_le_bytes());
            data.extend_from_slice(&triad_market_id.to_le_bytes());
            data.push(triad_direction);

            let accounts = vec![
                AccountMeta::new(ctx.accounts.user.key(), true),        // signer
                AccountMeta::new(ctx.accounts.user.key(), true),        // payer
                AccountMeta::new(ctx.accounts.triad_market.key(), false),    // market
                AccountMeta::new(ctx.accounts.triad_order_book.key(), false), // order_book
                AccountMeta::new(ctx.accounts.triad_order.key(), false),     // order
                AccountMeta::new(ctx.accounts.usdc_mint.key(), false),       // mint (USDC)
                AccountMeta::new(ctx.accounts.user_usdc_ata.key(), false),   // user_ata
                AccountMeta::new(ctx.accounts.triad_market_ata.key(), false), // market_ata
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ];

            let ix = anchor_lang::solana_program::instruction::Instruction {
                program_id: ctx.accounts.triad_program.key(),
                accounts,
                data,
            };

            anchor_lang::solana_program::program::invoke(
                &ix,
                &[
                    ctx.accounts.user.to_account_info(),
                    ctx.accounts.triad_market.to_account_info(),
                    ctx.accounts.triad_order_book.to_account_info(),
                    ctx.accounts.triad_order.to_account_info(),
                    ctx.accounts.usdc_mint.to_account_info(),
                    ctx.accounts.user_usdc_ata.to_account_info(),
                    ctx.accounts.triad_market_ata.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    ctx.accounts.associated_token_program.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;

            msg!("AtomicArb: Triad CPI completed");
        }

        // ── Leg 2: CPI into Jupiter Predict ──
        {
            // Jupiter order instruction data is pre-serialized by the engine
            // We pass it through directly as a CPI
            let mut jup_accounts = Vec::new();
            for acc in ctx.remaining_accounts.iter() {
                jup_accounts.push(if acc.is_writable {
                    AccountMeta::new(acc.key(), acc.is_signer)
                } else {
                    AccountMeta::new_readonly(acc.key(), acc.is_signer)
                });
            }

            let ix = anchor_lang::solana_program::instruction::Instruction {
                program_id: ctx.accounts.jupiter_program.key(),
                accounts: jup_accounts,
                data: jup_data,
            };

            // Collect remaining account infos for CPI
            let account_infos: Vec<AccountInfo> = ctx.remaining_accounts.to_vec();

            anchor_lang::solana_program::program::invoke(&ix, &account_infos)?;

            msg!("AtomicArb: Jupiter CPI completed");
        }

        // ── Assert BOTH fills ──
        // Reload token accounts to get post-CPI balances
        ctx.accounts.user_triad_outcome_ata.reload()?;
        ctx.accounts.user_jup_outcome_ata.reload()?;

        let triad_tokens_after = ctx.accounts.user_triad_outcome_ata.amount;
        let jup_tokens_after = ctx.accounts.user_jup_outcome_ata.amount;

        let triad_received = triad_tokens_after.saturating_sub(triad_tokens_before);
        let jup_received = jup_tokens_after.saturating_sub(jup_tokens_before);

        msg!(
            "AtomicArb: triad_received={}, jup_received={}, min_triad={}, min_jup={}",
            triad_received,
            jup_received,
            min_triad_tokens,
            min_jup_tokens
        );

        // ── CRITICAL ASSERTION ──
        // If Triad order is resting (not filled), triad_received = 0 → REVERT
        require!(
            triad_received >= min_triad_tokens,
            ArbError::TriadFillInsufficient
        );

        // If Jupiter order didn't fill, jup_received = 0 → REVERT
        require!(
            jup_received >= min_jup_tokens,
            ArbError::JupiterFillInsufficient
        );

        msg!(
            "AtomicArb: ✅ BOTH LEGS FILLED! Triad: +{} tokens, Jupiter: +{} tokens",
            triad_received,
            jup_received
        );

        Ok(())
    }
}

#[derive(Accounts)]
pub struct ExecuteArb<'info> {
    /// The user/bot wallet — signer and payer
    #[account(mut)]
    pub user: Signer<'info>,

    // ── Triad accounts ──
    /// CHECK: Triad program (TRDwq3BN4mP3m9KsuNUWSN6QDff93VKGSwE95Jbr9Ss)
    pub triad_program: UncheckedAccount<'info>,
    /// CHECK: Triad market PDA
    #[account(mut)]
    pub triad_market: UncheckedAccount<'info>,
    /// CHECK: Triad order book PDA
    #[account(mut)]
    pub triad_order_book: UncheckedAccount<'info>,
    /// CHECK: Triad order PDA for this user+market+direction
    #[account(mut)]
    pub triad_order: UncheckedAccount<'info>,
    /// CHECK: Triad market's USDC ATA
    #[account(mut)]
    pub triad_market_ata: UncheckedAccount<'info>,

    // ── Jupiter accounts ──
    /// CHECK: Jupiter Predict program
    pub jupiter_program: UncheckedAccount<'info>,

    // ── Token accounts ──
    /// CHECK: USDC mint
    #[account(mut)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// User's USDC ATA (source of funds)
    #[account(mut)]
    pub user_usdc_ata: Account<'info, TokenAccount>,
    /// User's Triad outcome token ATA (receives Triad fill)
    #[account(mut)]
    pub user_triad_outcome_ata: Account<'info, TokenAccount>,
    /// User's Jupiter outcome token ATA (receives Jupiter fill)
    #[account(mut)]
    pub user_jup_outcome_ata: Account<'info, TokenAccount>,

    // ── Programs ──
    pub token_program: Program<'info, Token>,
    /// CHECK: Associated Token Program
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ArbError {
    #[msg("Triad fill insufficient — order likely resting, not filled. Reverting to protect capital.")]
    TriadFillInsufficient,
    #[msg("Jupiter fill insufficient — order did not execute. Reverting to protect capital.")]
    JupiterFillInsufficient,
}
