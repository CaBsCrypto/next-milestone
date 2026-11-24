use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{Campaign, CampaignProposal, Contribution, EscrowError, Milestone};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateCampaign<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Campaign::INIT_SPACE,
        seeds = [b"campaign", creator.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(
        init,
        payer = creator,
        space = 8 + Milestone::INIT_SPACE,
        seeds = [b"milestone", campaign.key().as_ref(), &[0]],
        bump
    )]
    pub first_milestone: Box<Account<'info, Milestone>>,
    #[account(
        init,
        payer = creator,
        space = 8 + Milestone::INIT_SPACE,
        seeds = [b"milestone", campaign.key().as_ref(), &[1]],
        bump
    )]
    pub second_milestone: Box<Account<'info, Milestone>>,
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = campaign,
        associated_token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishProposal<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(has_one = creator @ EscrowError::Unauthorized)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        init,
        payer = creator,
        space = 8 + CampaignProposal::INIT_SPACE,
        seeds = [b"proposal", campaign.key().as_ref()],
        bump
    )]
    pub proposal: Account<'info, CampaignProposal>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    #[account(mut, has_one = mint, has_one = vault)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        init_if_needed,
        payer = contributor,
        space = 8 + Contribution::INIT_SPACE,
        seeds = [b"contribution", campaign.key().as_ref(), contributor.key().as_ref()],
        bump
    )]
    pub contribution: Account<'info, Contribution>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = contributor,
        token::token_program = token_program
    )]
    pub source: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = campaign,
        token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeFunding<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        has_one = campaign,
        seeds = [b"milestone", campaign.key().as_ref(), &[0]],
        bump = first_milestone.bump
    )]
    pub first_milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct SubmitEvidence<'info> {
    pub creator: Signer<'info>,
    #[account(has_one = creator @ EscrowError::Unauthorized)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        has_one = campaign,
        seeds = [b"milestone", campaign.key().as_ref(), &[index]],
        bump = milestone.bump
    )]
    pub milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReviewMilestone<'info> {
    pub reviewer: Signer<'info>,
    #[account(has_one = reviewer @ EscrowError::Unauthorized)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        has_one = campaign,
        seeds = [b"milestone", campaign.key().as_ref(), &[index]],
        bump = milestone.bump
    )]
    pub milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct AdvanceExpired<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        has_one = campaign,
        seeds = [b"milestone", campaign.key().as_ref(), &[index]],
        bump = milestone.bump
    )]
    pub milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReleaseMilestone<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(
        mut,
        has_one = mint,
        has_one = vault,
        seeds = [b"campaign", campaign.creator.as_ref(), &campaign.nonce.to_le_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(
        mut,
        has_one = campaign,
        seeds = [b"milestone", campaign.key().as_ref(), &[index]],
        bump = milestone.bump
    )]
    pub milestone: Box<Account<'info, Milestone>>,
    #[account(
        mut,
        has_one = campaign,
        seeds = [b"milestone", campaign.key().as_ref(), &[1]],
        bump = next_milestone.bump
    )]
    pub next_milestone: Option<Box<Account<'info, Milestone>>>,
    /// CHECK: The key is fixed to the creator recorded in the program account.
    #[account(address = campaign.creator @ EscrowError::Unauthorized)]
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = executor,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub destination: Box<Account<'info, TokenAccount>>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = campaign,
        token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    #[account(
        mut,
        has_one = mint,
        has_one = vault,
        seeds = [b"campaign", campaign.creator.as_ref(), &campaign.nonce.to_le_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(
        mut,
        has_one = campaign,
        has_one = contributor,
        seeds = [b"contribution", campaign.key().as_ref(), contributor.key().as_ref()],
        bump = contribution.bump
    )]
    pub contribution: Account<'info, Contribution>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = campaign,
        token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = mint,
        associated_token::authority = contributor,
        associated_token::token_program = token_program
    )]
    pub destination: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ContributorMilestone<'info> {
    pub contributor: Signer<'info>,
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        has_one = campaign,
        seeds = [b"milestone", campaign.key().as_ref(), &[index]],
        bump = milestone.bump
    )]
    pub milestone: Account<'info, Milestone>,
    #[account(
        has_one = campaign,
        has_one = contributor,
        seeds = [b"contribution", campaign.key().as_ref(), contributor.key().as_ref()],
        bump = contribution.bump
    )]
    pub contribution: Account<'info, Contribution>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ResolveDispute<'info> {
    pub arbitrator: Signer<'info>,
    #[account(
        mut,
        constraint = campaign.arbitrator == Some(arbitrator.key()) @ EscrowError::Unauthorized
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        has_one = campaign,
        seeds = [b"milestone", campaign.key().as_ref(), &[index]],
        bump = milestone.bump
    )]
    pub milestone: Account<'info, Milestone>,
}
