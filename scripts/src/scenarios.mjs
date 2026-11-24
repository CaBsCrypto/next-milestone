import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMint, transfer } from "@solana/spl-token";
import {
  advance,
  approve,
  balance,
  campaignState,
  cancelDispute,
  claim,
  clock,
  commitment,
  contribute,
  evidence,
  finalize,
  makeFixture,
  manifestEntry,
  milestoneState,
  openDispute,
  ownerAta,
  release,
  waitForClock,
} from "./chain.mjs";

const localWindows = { evidence: 10, review: 10, grace: 4, objection: 6, resolution: 10 };
const devnetWindows = { evidence: 30, review: 40, grace: 10, objection: 12, resolution: 40 };

function statusIs(account, expected) {
  assert.deepEqual(Object.keys(account.status), [expected], `Expected state ${expected}`);
}

async function assertRejected(action, label, code) {
  await assert.rejects(action, (error) => {
    const logs = (error?.logs ?? error?.transactionLogs ?? []).join("\n");
    assert.match(logs, new RegExp(`Error Code: ${code}\\b`), label);
    return true;
  }, label);
}

async function start(world, local, extra = {}) {
  return makeFixture(world, {
    nonce: randomBytes(8).readBigUInt64LE(),
    deadline: await clock(world.connection) + (local ? 30 : 240),
    windows: local ? localWindows : devnetWindows,
    ...extra,
  });
}

async function collect(fixture, contributions) {
  for (const [index, value] of contributions.entries()) {
    const owner = fixture.contributors[index].publicKey;
    const ata = ownerAta(fixture, owner);
    const beforeBalance = await balance(fixture, ata);
    await contribute(fixture, index, value);
    assert.equal(beforeBalance - await balance(fixture, ata), value, "Contribution debit");
  }
  const contributed = contributions.reduce((left, right) => left + right, 0n);
  assert.equal(await balance(fixture, fixture.vault), contributed, "Initial vault balance");
}

async function expire(fixture, index) {
  const state = await milestoneState(fixture, index);
  await waitForClock(fixture.connection, state.deadline.toNumber());
  await advance(fixture, index);
}

async function releaseApproved(fixture, index, evidenceBaseUrl, negativeTests) {
  const creatorAta = ownerAta(fixture, fixture.payer.publicKey);
  const before = await balance(fixture, creatorAta);
  if (negativeTests) {
    await assertRejected(() => release(fixture, index), "Payout before approval", "WrongState");
  }
  await evidence(fixture, index, evidenceBaseUrl);
  if (negativeTests) {
    await assertRejected(
      () => approve(fixture, index, fixture.contributors[1]), "Reviewer authority", "Unauthorized",
    );
  }
  await approve(fixture, index);
  if (fixture.options.arbitration) {
    statusIs(await milestoneState(fixture, index), "objection");
    if (negativeTests) {
      await assertRejected(() => release(fixture, index), "Payout during objection window", "WrongState");
    }
    await expire(fixture, index);
  }
  if (negativeTests) {
    await assertRejected(
      () => release(fixture, index, fixture.contributors[1].publicKey), "Immutable payout recipient", "Unauthorized",
    );
  }
  await release(fixture, index);
  assert.equal(await balance(fixture, creatorAta) - before, index === 0 ? 300n : 700n, "Creator ATA credit");
  statusIs(await milestoneState(fixture, index), "paid");
  if (negativeTests) {
    await assertRejected(() => release(fixture, index), "Duplicate payout", "WrongState");
  }
}

async function recover(fixture, order, amounts, negativeTests) {
  statusIs(await campaignState(fixture), "refunding");
  for (const index of order) {
    await claim(fixture, index, amounts[index]);
    if (negativeTests) {
      await assertRejected(() => claim(fixture, index, amounts[index]), "Duplicate refund", "AlreadyClaimed");
    }
  }
}

export async function cancelledCase(world, settings) {
  const {
    order, evidenceBaseUrl, local, dispute = false, silence = false, reviewerSilence = false,
    contributors = [600n, 400n], refunds = [420n, 280n], surplus = 0n,
    negativeTests = false,
  } = settings;
  const fixture = await start(world, local, { arbitration: dispute });
  if (negativeTests) {
    const wrongMint = await createMint(
      world.connection, world.payer, world.payer.publicKey, null, 0, undefined, { commitment },
    );
    await assertRejected(() => contribute(fixture, 0, 1_001n), "Funding cap", "TargetExceeded");
    await assertRejected(() => contribute(fixture, 0, 1n, wrongMint), "Campaign mint", "ConstraintHasOne");
  }
  await collect(fixture, contributors);
  await finalize(fixture);
  statusIs(await campaignState(fixture), "active");

  await releaseApproved(fixture, 0, evidenceBaseUrl, negativeTests);
  if (surplus > 0n) {
    await transfer(
      fixture.connection, fixture.payer, ownerAta(fixture, fixture.payer.publicKey),
      fixture.vault, fixture.payer, surplus, [], { commitment },
    );
  }
  assert.equal(await balance(fixture, fixture.vault), 700n + surplus, "Vault after first milestone");

  if (dispute || reviewerSilence) {
    await evidence(fixture, 1, evidenceBaseUrl);
    if (reviewerSilence) {
      await expire(fixture, 1);
    } else {
      await approve(fixture, 1);
      await openDispute(fixture, 1);
    }
    if (dispute) {
      statusIs(await milestoneState(fixture, 1), "resolving");
      if (negativeTests) {
        await assertRejected(() => release(fixture, 1), "Payout while a dispute is open", "WrongState");
      }
      if (silence) {
        await expire(fixture, 1);
      } else {
        await cancelDispute(fixture, 1);
      }
    }
  } else {
    await expire(fixture, 1);
    statusIs(await milestoneState(fixture, 1), "grace");
    await expire(fixture, 1);
  }
  statusIs(await milestoneState(fixture, 1), "cancelled");
  if (negativeTests) {
    await assertRejected(() => release(fixture, 1), "Payout after refund authorization", "WrongState");
  }

  await recover(fixture, order, refunds, negativeTests);
  const refunded = refunds[0] + refunds[1];
  assert.equal(await balance(fixture, fixture.vault), 700n + surplus - refunded, "Reconciled final vault");
  await assertLedger(fixture, 1_000n, 300n, refunded, 700n);
  return manifestEntry(fixture, dispute ? "dispute" : "expiry", order);
}

async function assertLedger(fixture, expectedContributed, expectedPaid, expectedRefunded, expectedSnapshot) {
  const campaign = await campaignState(fixture);
  for (const [actual, expected, field] of [
    [campaign.totalContributed, expectedContributed, "Contribution ledger"],
    [campaign.totalPaid, expectedPaid, "Payout ledger"],
    [campaign.totalRefunded, expectedRefunded, "Refund ledger"],
    [campaign.refundSnapshot, expectedSnapshot, "Immutable refund snapshot"],
    [campaign.refundDenominator, expectedSnapshot > 0n ? expectedContributed : 0n, "Refund denominator"],
  ]) {
    assert.equal(BigInt(actual.toString()), expected, field);
  }
}

async function failedFunding(world) {
  const deadline = await clock(world.connection) + 8;
  const fixture = await start(world, true, { deadline });
  await collect(fixture, [600n]);
  await assertRejected(() => finalize(fixture), "Early close with an unmet target", "WindowOpen");
  await waitForClock(world.connection, deadline);
  await finalize(fixture);
  await recover(fixture, [0], [600n], false);
  assert.equal(await balance(fixture, fixture.vault), 0n, "Failed campaign refunded in full");
  await assertLedger(fixture, 600n, 0n, 600n, 600n);
}

async function completedCampaign(world, evidenceBaseUrl) {
  const fixture = await start(world, true);
  await collect(fixture, [600n, 400n]);
  await finalize(fixture);
  await releaseApproved(fixture, 0, evidenceBaseUrl, false);
  await releaseApproved(fixture, 1, evidenceBaseUrl, false);
  statusIs(await campaignState(fixture), "completed");
  await assertRejected(() => claim(fixture, 0, 0n), "Refund after full payment", "WrongState");
  assert.equal(await balance(fixture, fixture.vault), 0n, "Completed campaign fully paid");
  await assertLedger(fixture, 1_000n, 1_000n, 0n, 0n);
}

export async function localAcceptance(world, evidenceBaseUrl) {
  const options = { local: true, evidenceBaseUrl };
  await cancelledCase(world, { ...options, order: [0, 1], negativeTests: true });
  console.log("PASS · expiry and claims A → B, rejection of invalid money and roles");
  await cancelledCase(world, { ...options, order: [1, 0] });
  console.log("PASS · expiry and claims B → A with identical amounts");
  await failedFunding(world);
  console.log("PASS · missed target and full refund");
  await completedCampaign(world, evidenceBaseUrl);
  console.log("PASS · both milestones paid, no refund");
  await cancelledCase(world, {
    ...options, order: [1, 0], contributors: [333n, 667n], refunds: [233n, 466n], surplus: 13n,
  });
  console.log("PASS · whole-token rounding and exclusion of out-of-band tokens");
  await cancelledCase(world, { ...options, order: [0, 1], dispute: true, negativeTests: true });
  console.log("PASS · objection freezes payment, arbitrator cancels");
  await cancelledCase(world, {
    ...options, order: [1, 0], dispute: true, reviewerSilence: true, silence: true,
  });
  console.log("PASS · reviewer silence escalates, arbitrator silence expires into refunds");
  await cancelledCase(world, { ...options, order: [0, 1], reviewerSilence: true });
  console.log("PASS · reviewer silence without arbitration authorizes refunds");
}
