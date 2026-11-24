use anchor_lang::prelude::*;
use anchor_spl::token::{self, TransferChecked};

mod contexts;
mod state;

pub use contexts::*;
pub use state::*;

declare_id!("G5TYizzLmGWWbcEYhUgz8pdZupqgHKRkiKszz3UUPaHk");

#[program]
pub mod next_milestone {
    use super::*;

    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        nonce: u64,
        target: u64,
        amounts: [u64; 2],
        funding_deadline: i64,
        windows: Windows,
        reviewer: Pubkey,
        arbitrator: Option<Pubkey>,
    ) -> Result<()> {
        let creator = ctx.accounts.creator.key();
        let now = Clock::get()?.unix_timestamp;
        require!(
            amounts.iter().all(|amount| *amount > 0)
                && amounts[0].checked_add(amounts[1]) == Some(target)
                && now < funding_deadline
                && ctx.accounts.mint.freeze_authority.is_none(),
            EscrowError::InvalidTerms
        );
        require!(
            reviewer != Pubkey::default() && reviewer != creator && reviewer.is_on_curve(),
            EscrowError::InvalidTerms
        );
        if let Some(arbitrator) = arbitrator {
            require!(
                arbitrator != Pubkey::default()
                    && arbitrator != creator
                    && arbitrator != reviewer
                    && arbitrator.is_on_curve(),
                EscrowError::InvalidTerms
            );
        }
        windows.validate()?;

        let campaign = &mut ctx.accounts.campaign;
        campaign.set_inner(Campaign {
            creator,
            reviewer,
            arbitrator,
            mint: ctx.accounts.mint.key(),
            vault: ctx.accounts.vault.key(),
            nonce,
            target,
            funding_deadline,
            status: CampaignStatus::Funding,
            active_milestone: 0,
            total_contributed: 0,
            total_paid: 0,
            total_refunded: 0,
            refund_snapshot: 0,
            refund_denominator: 0,
            contributor_count: 0,
            claimed_count: 0,
            windows,
            version: 1,
            bump: ctx.bumps.campaign,
        });
        ctx.accounts.first_milestone.set_inner(Milestone::new(
            campaign.key(),
            0,
            amounts[0],
            ctx.bumps.first_milestone,
        ));
        ctx.accounts.second_milestone.set_inner(Milestone::new(
            campaign.key(),
            1,
            amounts[1],
            ctx.bumps.second_milestone,
        ));
        Ok(())
    }

    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let contribution = &mut ctx.accounts.contribution;
        require!(
            campaign.status == CampaignStatus::Funding,
            EscrowError::WrongState
        );
        require!(
            Clock::get()?.unix_timestamp < campaign.funding_deadline,
            EscrowError::WindowExpired
        );
        require!(amount > 0, EscrowError::InvalidContribution);
        let new_total = add_amount(campaign.total_contributed, amount)?;
        require!(new_total <= campaign.target, EscrowError::TargetExceeded);

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.contributor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        if contribution.amount == 0 {
            contribution.campaign = campaign.key();
            contribution.contributor = ctx.accounts.contributor.key();
            contribution.bump = ctx.bumps.contribution;
            campaign.contributor_count = campaign
                .contributor_count
                .checked_add(1)
                .ok_or(EscrowError::MathOverflow)?;
        }
        contribution.amount = add_amount(contribution.amount, amount)?;
        campaign.total_contributed = new_total;
        Ok(())
    }

    pub fn finalize_funding(ctx: Context<FinalizeFunding>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let first = &mut ctx.accounts.first_milestone;
        let now = Clock::get()?.unix_timestamp;
        require!(
            campaign.status == CampaignStatus::Funding,
            EscrowError::WrongState
        );
        if campaign.total_contributed == campaign.target {
            first.start(now, campaign.windows)?;
            campaign.status = CampaignStatus::Active;
        } else {
            require!(now >= campaign.funding_deadline, EscrowError::WindowOpen);
            first.enter_untimed(MilestoneStatus::Cancelled);
            campaign.cancel()?;
        }
        Ok(())
    }

    pub fn submit_evidence(
        ctx: Context<SubmitEvidence>,
        index: u8,
        hash: [u8; 32],
        uri: String,
    ) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let milestone = &mut ctx.accounts.milestone;
        let now = Clock::get()?.unix_timestamp;
        campaign.require_active(index)?;
        require!(
            matches!(
                milestone.status,
                MilestoneStatus::Executing | MilestoneStatus::Grace
            ),
            EscrowError::WrongState
        );
        milestone.require_before_deadline(now)?;
        validate_evidence(&hash, &uri)?;

        milestone.evidence_version = milestone
            .evidence_version
            .checked_add(1)
            .ok_or(EscrowError::MathOverflow)?;
        milestone.evidence_hash = hash;
        milestone.evidence_uri = uri;
        if milestone.dispute_evidence_version > 0 {
            milestone.enter_timed(MilestoneStatus::Resolving, now, campaign.windows.resolution)
        } else {
            milestone.enter_timed(MilestoneStatus::Review, now, campaign.windows.review)
        }
    }

    pub fn review_milestone(
        ctx: Context<ReviewMilestone>,
        index: u8,
        evidence_version: u32,
        decision: ReviewDecision,
    ) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let milestone = &mut ctx.accounts.milestone;
        let now = Clock::get()?.unix_timestamp;
        campaign.require_active(index)?;
        milestone.require_status(MilestoneStatus::Review)?;
        milestone.require_before_deadline(now)?;
        milestone.require_evidence_version(evidence_version)?;

        match decision {
            ReviewDecision::Approve if campaign.arbitrator.is_some() => {
                milestone.enter_timed(MilestoneStatus::Objection, now, campaign.windows.objection)
            }
            ReviewDecision::Approve => {
                milestone.enter_untimed(MilestoneStatus::Payable);
                Ok(())
            }
            ReviewDecision::RequestGrace => milestone.open_grace(now, campaign.windows.grace),
        }
    }

    pub fn advance_expired(ctx: Context<AdvanceExpired>, index: u8) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let milestone = &mut ctx.accounts.milestone;
        campaign.require_active(index)?;
        milestone.require_deadline_reached(Clock::get()?.unix_timestamp)?;
        let expired_at = milestone.deadline;

        match milestone.status {
            MilestoneStatus::Executing if !milestone.grace_used => {
                milestone.open_grace(expired_at, campaign.windows.grace)
            }
            MilestoneStatus::Review if campaign.arbitrator.is_some() => {
                milestone.start_resolution(None, expired_at, campaign.windows.resolution)
            }
            MilestoneStatus::Objection => {
                milestone.enter_untimed(MilestoneStatus::Payable);
                Ok(())
            }
            MilestoneStatus::Executing
            | MilestoneStatus::Review
            | MilestoneStatus::Grace
            | MilestoneStatus::Resolving => {
                milestone.enter_untimed(MilestoneStatus::Cancelled);
                campaign.cancel()
            }
            _ => err!(EscrowError::WrongState),
        }
    }

    pub fn open_dispute(ctx: Context<ContributorMilestone>, index: u8) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let milestone = &mut ctx.accounts.milestone;
        let now = Clock::get()?.unix_timestamp;
        campaign.require_active(index)?;
        require!(
            ctx.accounts.contribution.amount > 0,
            EscrowError::InvalidContribution
        );
        milestone.require_status(MilestoneStatus::Objection)?;
        milestone.require_before_deadline(now)?;

        milestone.start_resolution(
            Some(ctx.accounts.contributor.key()),
            now,
            campaign.windows.resolution,
        )
    }

    pub fn append_dispute_evidence(
        ctx: Context<ContributorMilestone>,
        index: u8,
        hash: [u8; 32],
        uri: String,
    ) -> Result<()> {
        let milestone = &ctx.accounts.milestone;
        ctx.accounts.campaign.require_active(index)?;
        require!(
            ctx.accounts.contribution.amount > 0,
            EscrowError::InvalidContribution
        );
        milestone.require_status(MilestoneStatus::Resolving)?;
        milestone.require_before_deadline(Clock::get()?.unix_timestamp)?;
        validate_evidence(&hash, &uri)?;

        emit!(DisputeEvidence {
            campaign: ctx.accounts.campaign.key(),
            index,
            contributor: ctx.accounts.contributor.key(),
            hash,
            uri,
        });
        Ok(())
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        index: u8,
        evidence_version: u32,
        decision: DisputeDecision,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let milestone = &mut ctx.accounts.milestone;
        let now = Clock::get()?.unix_timestamp;
        campaign.require_active(index)?;
        milestone.require_status(MilestoneStatus::Resolving)?;
        milestone.require_before_deadline(now)?;
        milestone.require_evidence_version(evidence_version)?;

        match decision {
            DisputeDecision::Release => {
                milestone.enter_untimed(MilestoneStatus::Payable);
                Ok(())
            }
            DisputeDecision::RequestGrace => milestone.open_grace(now, campaign.windows.grace),
            DisputeDecision::Cancel => {
                milestone.enter_untimed(MilestoneStatus::Cancelled);
                campaign.cancel()
            }
        }
    }

    pub fn release_milestone(ctx: Context<ReleaseMilestone>, index: u8) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let milestone = &mut ctx.accounts.milestone;
        campaign.require_active(index)?;
        milestone.require_status(MilestoneStatus::Payable)?;
        let new_paid = add_amount(campaign.total_paid, milestone.amount)?;
        require!(
            new_paid <= campaign.total_contributed,
            EscrowError::MathOverflow
        );

        if index == 0 {
            let next = ctx
                .accounts
                .next_milestone
                .as_mut()
                .ok_or(EscrowError::MissingNextMilestone)?;
            next.start(Clock::get()?.unix_timestamp, campaign.windows)?;
            campaign.active_milestone = 1;
        } else {
            require!(
                ctx.accounts.next_milestone.is_none(),
                EscrowError::WrongState
            );
            campaign.status = CampaignStatus::Completed;
        }

        transfer_from_vault(
            campaign,
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: campaign.to_account_info(),
            },
            milestone.amount,
            ctx.accounts.mint.decimals,
        )?;
        milestone.enter_untimed(MilestoneStatus::Paid);
        campaign.total_paid = new_paid;
        Ok(())
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let contribution = &mut ctx.accounts.contribution;
        require!(
            campaign.status == CampaignStatus::Refunding,
            EscrowError::WrongState
        );
        require!(!contribution.claimed, EscrowError::AlreadyClaimed);
        require!(contribution.amount > 0, EscrowError::InvalidContribution);

        let amount = refund_share(
            contribution.amount,
            campaign.refund_snapshot,
            campaign.refund_denominator,
        )?;
        let new_refunded = add_amount(campaign.total_refunded, amount)?;
        require!(
            new_refunded <= campaign.refund_snapshot,
            EscrowError::MathOverflow
        );
        if amount > 0 {
            transfer_from_vault(
                campaign,
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: campaign.to_account_info(),
                },
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }
        campaign.total_refunded = new_refunded;
        campaign.claimed_count = campaign
            .claimed_count
            .checked_add(1)
            .ok_or(EscrowError::MathOverflow)?;
        contribution.claimed = true;
        Ok(())
    }
}

fn add_amount(existing: u64, amount: u64) -> Result<u64> {
    existing
        .checked_add(amount)
        .ok_or_else(|| error!(EscrowError::MathOverflow))
}

fn transfer_from_vault<'info>(
    campaign: &Campaign,
    token_program: Pubkey,
    accounts: TransferChecked<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let nonce = campaign.nonce.to_le_bytes();
    let bump = [campaign.bump];
    let seeds = &[b"campaign", campaign.creator.as_ref(), &nonce, &bump];
    token::transfer_checked(
        CpiContext::new(token_program, accounts).with_signer(&[seeds]),
        amount,
        decimals,
    )
}

#[event]
pub struct DisputeEvidence {
    pub campaign: Pubkey,
    pub index: u8,
    pub contributor: Pubkey,
    pub hash: [u8; 32],
    pub uri: String,
}

#[error_code]
pub enum EscrowError {
    #[msg("The campaign terms, mint, roles, or deadlines are invalid.")]
    InvalidTerms,
    #[msg("This action is unavailable in the current state.")]
    WrongState,
    #[msg("This stage's deadline has passed.")]
    WindowExpired,
    #[msg("This stage's deadline has not been reached.")]
    WindowOpen,
    #[msg("This signer does not have the required role.")]
    Unauthorized,
    #[msg("Amount or contributor position is invalid.")]
    InvalidContribution,
    #[msg("This contribution exceeds the remaining funding target.")]
    TargetExceeded,
    #[msg("The evidence hash or URI is invalid.")]
    InvalidEvidence,
    #[msg("This decision refers to an older evidence version.")]
    StaleEvidence,
    #[msg("This milestone has already used its grace window.")]
    GraceAlreadyUsed,
    #[msg("Provide the second milestone when releasing the first payment.")]
    MissingNextMilestone,
    #[msg("This contribution has already been refunded.")]
    AlreadyClaimed,
    #[msg("Arithmetic exceeded the permitted bounds.")]
    MathOverflow,
}
