use anchor_lang::prelude::*;

use crate::EscrowError;

pub const MAX_EVIDENCE_URI: usize = 160;
pub const MAX_PROPOSAL_URI: usize = 256;
const MAX_WINDOW_SECONDS: i64 = 30 * 24 * 60 * 60;

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub creator: Pubkey,
    pub reviewer: Pubkey,
    pub arbitrator: Option<Pubkey>,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub nonce: u64,
    pub target: u64,
    pub funding_deadline: i64,
    pub status: CampaignStatus,
    pub active_milestone: u8,
    pub total_contributed: u64,
    pub total_paid: u64,
    pub total_refunded: u64,
    pub refund_snapshot: u64,
    pub refund_denominator: u64,
    pub contributor_count: u32,
    pub claimed_count: u32,
    pub windows: Windows,
    pub version: u8,
    pub bump: u8,
}

impl Campaign {
    pub fn cancel(&mut self) -> Result<()> {
        self.refund_snapshot = self
            .total_contributed
            .checked_sub(self.total_paid)
            .ok_or(EscrowError::MathOverflow)?;
        self.refund_denominator = self.total_contributed;
        self.status = CampaignStatus::Refunding;
        Ok(())
    }

    pub fn require_active(&self, index: u8) -> Result<()> {
        require!(
            self.status == CampaignStatus::Active && self.active_milestone == index,
            EscrowError::WrongState
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct CampaignProposal {
    pub campaign: Pubkey,
    pub sha256: [u8; 32],
    #[max_len(256)]
    pub uri: String,
    pub bump: u8,
}

impl CampaignProposal {
    pub fn validate(sha256: &[u8; 32], uri: &str) -> Result<()> {
        let authority = uri
            .strip_prefix("https://")
            .and_then(|rest| rest.split(['/', '?', '#']).next());
        require!(
            *sha256 != [0; 32]
                && uri.len() <= MAX_PROPOSAL_URI
                && uri
                    .bytes()
                    .all(|byte| byte.is_ascii_graphic() && byte != b'\\')
                && authority.is_some_and(|host| !host.is_empty() && !host.contains('@')),
            EscrowError::InvalidProposal
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CampaignStatus {
    Funding,
    Active,
    Refunding,
    Completed,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy)]
pub struct Windows {
    pub evidence: i64,
    pub review: i64,
    pub grace: i64,
    pub objection: i64,
    pub resolution: i64,
}

impl Windows {
    pub fn validate(&self) -> Result<()> {
        require!(
            [
                self.evidence,
                self.review,
                self.grace,
                self.objection,
                self.resolution
            ]
            .into_iter()
            .all(|duration| (1..=MAX_WINDOW_SECONDS).contains(&duration)),
            EscrowError::InvalidTerms
        );
        Ok(())
    }

    fn horizon(&self) -> i64 {
        // Each milestone has one grace period and may return to review or resolution.
        self.evidence + 2 * self.review + self.grace + self.objection + 2 * self.resolution
    }
}

#[account]
#[derive(InitSpace)]
pub struct Milestone {
    pub campaign: Pubkey,
    pub index: u8,
    pub amount: u64,
    pub status: MilestoneStatus,
    pub deadline: i64,
    pub hard_deadline: i64,
    pub evidence_version: u32,
    pub evidence_hash: [u8; 32],
    #[max_len(160)]
    pub evidence_uri: String,
    pub grace_used: bool,
    pub dispute_opened_by: Option<Pubkey>,
    pub dispute_evidence_version: u32,
    pub dispute_evidence_hash: [u8; 32],
    pub bump: u8,
}

impl Milestone {
    pub fn new(campaign: Pubkey, index: u8, amount: u64, bump: u8) -> Self {
        Self {
            campaign,
            index,
            amount,
            status: MilestoneStatus::Pending,
            deadline: 0,
            hard_deadline: 0,
            evidence_version: 0,
            evidence_hash: [0; 32],
            evidence_uri: String::new(),
            grace_used: false,
            dispute_opened_by: None,
            dispute_evidence_version: 0,
            dispute_evidence_hash: [0; 32],
            bump,
        }
    }

    pub fn start(&mut self, now: i64, windows: Windows) -> Result<()> {
        self.require_status(MilestoneStatus::Pending)?;
        self.hard_deadline = checked_deadline(now, windows.horizon())?;
        self.enter_timed(MilestoneStatus::Executing, now, windows.evidence)
    }

    pub fn enter_timed(
        &mut self,
        status: MilestoneStatus,
        start: i64,
        duration: i64,
    ) -> Result<()> {
        self.deadline = checked_deadline(start, duration)?.min(self.hard_deadline);
        self.status = status;
        Ok(())
    }

    pub fn enter_untimed(&mut self, status: MilestoneStatus) {
        self.status = status;
        self.deadline = 0;
    }

    pub fn require_status(&self, expected: MilestoneStatus) -> Result<()> {
        require!(self.status == expected, EscrowError::WrongState);
        Ok(())
    }

    pub fn require_before_deadline(&self, now: i64) -> Result<()> {
        require!(now < self.deadline, EscrowError::WindowExpired);
        Ok(())
    }

    pub fn require_deadline_reached(&self, now: i64) -> Result<()> {
        require!(self.deadline > 0, EscrowError::WrongState);
        require!(now >= self.deadline, EscrowError::WindowOpen);
        Ok(())
    }

    pub fn require_evidence_version(&self, version: u32) -> Result<()> {
        require!(version == self.evidence_version, EscrowError::StaleEvidence);
        Ok(())
    }

    pub fn open_grace(&mut self, start: i64, duration: i64) -> Result<()> {
        require!(!self.grace_used, EscrowError::GraceAlreadyUsed);
        self.enter_timed(MilestoneStatus::Grace, start, duration)?;
        self.grace_used = true;
        Ok(())
    }

    pub fn start_resolution(
        &mut self,
        opener: Option<Pubkey>,
        start: i64,
        duration: i64,
    ) -> Result<()> {
        require!(self.dispute_evidence_version == 0, EscrowError::WrongState);
        self.enter_timed(MilestoneStatus::Resolving, start, duration)?;
        self.dispute_evidence_version = self.evidence_version;
        self.dispute_evidence_hash = self.evidence_hash;
        self.dispute_opened_by = opener;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MilestoneStatus {
    Pending,
    Executing,
    Review,
    Objection,
    Resolving,
    Grace,
    Payable,
    Paid,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Contribution {
    pub campaign: Pubkey,
    pub contributor: Pubkey,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum ReviewDecision {
    Approve,
    RequestGrace,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum DisputeDecision {
    Release,
    RequestGrace,
    Cancel,
}

pub fn validate_evidence(hash: &[u8; 32], uri: &str) -> Result<()> {
    require!(
        *hash != [0; 32] && !uri.is_empty() && uri.len() <= MAX_EVIDENCE_URI,
        EscrowError::InvalidEvidence
    );
    Ok(())
}

fn checked_deadline(start: i64, duration: i64) -> Result<i64> {
    start
        .checked_add(duration)
        .ok_or_else(|| error!(EscrowError::MathOverflow))
}

pub fn refund_share(contribution: u64, snapshot: u64, denominator: u64) -> Result<u64> {
    require!(denominator > 0, EscrowError::InvalidContribution);
    let share = u128::from(contribution) * u128::from(snapshot) / u128::from(denominator);
    u64::try_from(share).map_err(|_| error!(EscrowError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows() -> Windows {
        Windows {
            evidence: 10,
            review: 15,
            grace: 4,
            objection: 5,
            resolution: 20,
        }
    }

    #[test]
    fn exact_refunds_reconcile_in_both_orders() {
        for contributions in [[600, 400], [400, 600]] {
            let amounts =
                contributions.map(|contribution| refund_share(contribution, 700, 1000).unwrap());
            assert_eq!(
                amounts,
                contributions.map(|amount| if amount == 600 { 420 } else { 280 })
            );
            assert_eq!(amounts.into_iter().sum::<u64>() + 300, 1000);
        }
    }

    #[test]
    fn refund_rounds_down_and_handles_full_width_amounts() {
        assert_eq!(refund_share(1, 2, 3).unwrap(), 0);
        assert_eq!(refund_share(2, 2, 3).unwrap(), 1);
        assert_eq!(
            refund_share(u64::MAX, u64::MAX, u64::MAX).unwrap(),
            u64::MAX
        );
        assert!(refund_share(0, 0, 0).is_err());
    }

    #[test]
    fn evidence_cannot_be_submitted_at_the_deadline() {
        let mut milestone = Milestone::new(Pubkey::default(), 0, 300, 0);
        milestone.start(100, windows()).unwrap();
        assert_eq!(milestone.deadline, 110);
        assert!(milestone.require_before_deadline(109).is_ok());
        assert!(milestone.require_deadline_reached(109).is_err());
        assert!(milestone.require_before_deadline(110).is_err());
        assert!(milestone.require_deadline_reached(110).is_ok());
        assert!(milestone.require_deadline_reached(111).is_ok());
    }

    #[test]
    fn grace_is_single_and_never_extends_the_hard_deadline() {
        let mut milestone = Milestone::new(Pubkey::default(), 1, 700, 0);
        milestone.start(100, windows()).unwrap();
        let hard_deadline = milestone.hard_deadline;
        milestone.open_grace(hard_deadline - 1, 4).unwrap();
        assert_eq!(milestone.deadline, hard_deadline);
        assert!(milestone.open_grace(hard_deadline - 1, 4).is_err());
    }
}
