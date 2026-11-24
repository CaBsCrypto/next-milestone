import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import anchor from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
} from "@solana/web3.js";

const { BN, Program } = anchor;

export const commitment = "confirmed";
export const devnetGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export function amount(value) {
  return new BN(value.toString());
}

export function variant(value) {
  return { [value]: {} };
}

export async function clock(connection) {
  const account = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, commitment);
  assert.ok(account?.data.length >= 40, "Solana Clock sysvar unavailable");
  return Number(account.data.readBigInt64LE(32));
}

export async function waitForClock(connection, deadline) {
  const timeout = Date.now() + Math.max(90, deadline - await clock(connection) + 45) * 1_000;
  while (await clock(connection) < deadline) {
    if (Date.now() >= timeout) {
      throw new Error(`Solana Clock stalled before deadline ${deadline}`);
    }
    await delay(500);
  }
}

export async function newWorld(connection, idl, payer) {
  const program = new Program(idl, { connection });
  const onChainProgram = await connection.getAccountInfo(program.programId, commitment);
  assert.ok(onChainProgram?.executable, "IDL program is not executable at this RPC");

  const reviewer = Keypair.generate();
  const arbitrator = Keypair.generate();
  const contributors = [Keypair.generate(), Keypair.generate()];
  const contributorFunding = contributors.map(({ publicKey }) => SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: publicKey,
    lamports: LAMPORTS_PER_SOL / 50,
  }));
  await sendAndConfirmTransaction(
    connection, new Transaction().add(...contributorFunding), [payer], { commitment },
  );
  const balances = new Map();
  const mint = await createMint(connection, payer, payer.publicKey, null, 0, undefined, { commitment });
  for (const owner of [payer, ...contributors]) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, payer, mint, owner.publicKey, false, commitment, { commitment },
    );
    balances.set(owner.publicKey.toBase58(), ata.address);
    if (owner !== payer) {
      await mintTo(connection, payer, mint, ata.address, payer, 10_000n, [], { commitment });
    }
  }

  return { connection, program, payer, reviewer, arbitrator, contributors, mint, balances };
}

function pda(programId, ...seeds) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function deriveCampaign(world, nonce) {
  const nonceSeed = Buffer.alloc(8);
  nonceSeed.writeBigUInt64LE(nonce);
  const programId = world.program.programId;
  const campaign = pda(programId, Buffer.from("campaign"), world.payer.publicKey.toBuffer(), nonceSeed);
  const milestones = [0, 1].map((index) =>
    pda(programId, Buffer.from("milestone"), campaign.toBuffer(), Buffer.from([index])),
  );
  const contributions = world.contributors.map((owner) =>
    pda(programId, Buffer.from("contribution"), campaign.toBuffer(), owner.publicKey.toBuffer()),
  );
  const vault = getAssociatedTokenAddressSync(world.mint, campaign, true);
  return { campaign, milestones, contributions, vault };
}

export async function makeFixture(world, options) {
  const { nonce, deadline, windows, arbitration = false } = options;
  const ids = deriveCampaign(world, nonce);
  const fixture = { ...world, ...ids, options, activities: [], transactionNumber: 0 };
  const createSignature = await call(fixture, "createCampaign", [
    amount(nonce),
    amount(1_000),
    [amount(300), amount(700)],
    amount(deadline),
    Object.fromEntries(Object.entries(windows).map(([name, seconds]) => [name, amount(seconds)])),
    world.reviewer.publicKey,
    arbitration ? world.arbitrator.publicKey : null,
  ], {
    creator: world.payer.publicKey,
    campaign: ids.campaign,
    firstMilestone: ids.milestones[0],
    secondMilestone: ids.milestones[1],
    mint: world.mint,
    vault: ids.vault,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });
  note(fixture, "create", createSignature);
  return fixture;
}

export async function call(fixture, method, args, accounts, signer = fixture.payer) {
  const instruction = await fixture.program.methods[method](...args).accountsStrict(accounts).instruction();
  const signers = signer.publicKey.equals(fixture.payer.publicKey) ? [fixture.payer] : [fixture.payer, signer];
  return sendAndConfirmTransaction(
    fixture.connection,
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fixture.transactionNumber++ }),
      instruction,
    ),
    signers,
    { commitment, preflightCommitment: commitment },
  );
}

export function note(fixture, kind, signature, data = {}) {
  fixture.activities.push({ kind, signature, ...data });
}

export function ownerAta(fixture, owner) {
  const ata = fixture.balances.get(owner.toBase58());
  assert.ok(ata, "Missing fixture token account");
  return ata;
}

export async function balance(fixture, address) {
  const tokens = await fixture.connection.getTokenAccountBalance(address, commitment);
  return BigInt(tokens.value.amount);
}

export async function contribute(fixture, index, value, mint = fixture.mint) {
  const contributor = fixture.contributors[index];
  const signature = await call(fixture, "contribute", [amount(value)], {
    contributor: contributor.publicKey,
    campaign: fixture.campaign,
    contribution: fixture.contributions[index],
    mint,
    source: ownerAta(fixture, contributor.publicKey),
    vault: fixture.vault,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }, contributor);
  note(fixture, "contribution", signature, { wallet: contributor.publicKey.toBase58(), amount: value.toString() });
}

export async function finalize(fixture) {
  const signature = await call(fixture, "finalizeFunding", [], {
    campaign: fixture.campaign,
    firstMilestone: fixture.milestones[0],
  });
  note(fixture, "finalize", signature);
}

export function milestoneAccounts(fixture, index) {
  return { campaign: fixture.campaign, milestone: fixture.milestones[index] };
}

export async function evidence(fixture, index, baseUrl, signer = fixture.payer) {
  const filename = `hito-${index + 1}.json`;
  const uri = new URL(filename, baseUrl).href;
  const data = await readFile(new URL(`../../web/public/evidence/${filename}`, import.meta.url));
  const hash = createHash("sha256").update(data).digest();
  const signature = await call(fixture, "submitEvidence", [index, [...hash], uri], {
    creator: signer.publicKey,
    ...milestoneAccounts(fixture, index),
  }, signer);
  note(fixture, "evidence", signature, { milestoneIndex: index });
}

export async function approve(fixture, index, signer = fixture.reviewer) {
  const signature = await call(fixture, "reviewMilestone", [index, 1, variant("approve")], {
    reviewer: signer.publicKey,
    ...milestoneAccounts(fixture, index),
  }, signer);
  note(fixture, "approval", signature, { milestoneIndex: index });
}

export async function advance(fixture, index) {
  const signature = await call(
    fixture, "advanceExpired", [index], milestoneAccounts(fixture, index),
  );
  note(fixture, "advance", signature, { milestoneIndex: index });
}

export async function release(fixture, index, recipient = fixture.payer.publicKey) {
  const signature = await call(fixture, "releaseMilestone", [index], {
    executor: fixture.payer.publicKey,
    ...milestoneAccounts(fixture, index),
    nextMilestone: fixture.milestones[index + 1] ?? null,
    recipient,
    destination: ownerAta(fixture, recipient),
    mint: fixture.mint,
    vault: fixture.vault,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });
  note(fixture, "release", signature, { milestoneIndex: index, wallet: recipient.toBase58(), amount: index === 0 ? "300" : "700" });
}

export async function claim(fixture, index, value) {
  const contributor = fixture.contributors[index];
  const destination = ownerAta(fixture, contributor.publicKey);
  const before = await balance(fixture, destination);
  const signature = await call(fixture, "claimRefund", [], {
    contributor: contributor.publicKey,
    campaign: fixture.campaign,
    contribution: fixture.contributions[index],
    mint: fixture.mint,
    vault: fixture.vault,
    destination,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }, contributor);
  assert.equal(await balance(fixture, destination) - before, value, "Claim ATA credit");
  note(fixture, "refund", signature, { wallet: contributor.publicKey.toBase58(), amount: value.toString() });
}

export async function openDispute(fixture, index) {
  const signer = fixture.contributors[0];
  const signature = await call(fixture, "openDispute", [index], {
    contributor: signer.publicKey,
    ...milestoneAccounts(fixture, index),
    contribution: fixture.contributions[0],
  }, signer);
  note(fixture, "dispute", signature, { milestoneIndex: index, wallet: signer.publicKey.toBase58() });
}

export async function cancelDispute(fixture, index) {
  const signature = await call(fixture, "resolveDispute", [index, 1, variant("cancel")], {
    arbitrator: fixture.arbitrator.publicKey,
    ...milestoneAccounts(fixture, index),
  }, fixture.arbitrator);
  note(fixture, "resolution", signature, { milestoneIndex: index });
}

export function campaignState(fixture) {
  return fixture.program.account.campaign.fetch(fixture.campaign, commitment);
}

export function milestoneState(fixture, index) {
  return fixture.program.account.milestone.fetch(fixture.milestones[index], commitment);
}

export function manifestEntry(fixture, variantName, claimOrder) {
  return {
    campaignId: fixture.campaign.toBase58(),
    vault: fixture.vault.toBase58(),
    milestones: fixture.milestones.map((account) => account.toBase58()),
    participants: {
      creator: fixture.payer.publicKey.toBase58(),
      reviewer: fixture.reviewer.publicKey.toBase58(),
      ...(fixture.options.arbitration && { arbitrator: fixture.arbitrator.publicKey.toBase58() }),
      contributors: fixture.contributors.map((signer) => signer.publicKey.toBase58()),
    },
    contributions: fixture.contributions.map((account) => account.toBase58()),
    activities: fixture.activities,
    variant: variantName,
    claimOrder: claimOrder.map((index) => index === 0 ? "A" : "B"),
  };
}
