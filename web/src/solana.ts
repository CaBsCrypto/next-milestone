import { BN, BorshInstructionCoder, type Idl, Program, type Provider, utils } from '@anchor-lang/core';
import { Connection, PublicKey, SystemProgram, Transaction, type VersionedTransactionResponse } from '@solana/web3.js';
import { parseMilestoneEvidence } from '../shared/evidence';
import { campaignAddress, MAX_PROPOSAL_BYTES, MAX_WINDOW_SECONDS, parseCampaignProposal, publicBlobUrl } from '../shared/proposal';
import type { Activity, Milestone, Progress } from './campaign';
import { ASSOCIATED_TOKEN_PROGRAM_ID, associatedTokenAddress, TOKEN_PROGRAM_ID } from './tokenAddress';

export type BrowserWallet = {
  publicKey: PublicKey | null;
  connect(options?: { onlyIfTrusted: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
  signMessage?(message: Uint8Array, display?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
  on?(event: 'accountChanged' | 'disconnect', listener: (publicKey?: PublicKey) => void): void;
  off?(event: 'accountChanged' | 'disconnect', listener: (publicKey?: PublicKey) => void): void;
};

export type PendingSignature = { signature: string; lastValidBlockHeight: number };

export function isPendingSignature(value: unknown): value is PendingSignature {
  if (typeof value !== 'object' || value === null) return false;
  const { signature, lastValidBlockHeight } = value as Partial<PendingSignature>;
  if (typeof signature !== 'string' || signature.length < 64 || signature.length > 88
    || typeof lastValidBlockHeight !== 'number' || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 0) return false;
  try {
    return utils.bytes.bs58.decode(signature).length === 64;
  } catch {
    return false;
  }
}

declare global {
  interface Window {
    phantom?: { solana: BrowserWallet };
    solana?: BrowserWallet;
  }
}

export type Action =
  | { kind: 'contribute'; amount: bigint }
  | { kind: 'finalize' }
  | { kind: 'submit' | 'append'; index: number; hash: string; uri: string }
  | { kind: 'review'; index: number; version: number; decision: 'approve' | 'requestGrace' }
  | { kind: 'approveAndRelease'; index: number; version: number }
  | { kind: 'advance'; index: number }
  | { kind: 'release'; index: number }
  | { kind: 'refund' }
  | { kind: 'object'; index: number }
  | { kind: 'resolve'; index: number; version: number; decision: 'release' | 'requestGrace' | 'cancel' };

type StateEnum = Record<string, unknown>;
type CampaignAccount = {
  creator: PublicKey;
  reviewer: PublicKey;
  arbitrator: PublicKey | null;
  mint: PublicKey;
  vault: PublicKey;
  nonce: BN;
  windows: { evidence: BN };
  status: StateEnum;
  activeMilestone: number;
  target: BN;
  totalContributed: BN;
  totalPaid: BN;
  totalRefunded: BN;
  refundSnapshot: BN;
  fundingDeadline: BN;
  contributorCount: number;
};
type MilestoneAccount = {
  campaign: PublicKey;
  index: number;
  amount: BN;
  status: StateEnum;
  deadline: BN;
  hardDeadline: BN;
  evidenceVersion: number;
  evidenceHash: number[];
  evidenceUri: string;
  graceUsed: boolean;
  disputeOpenedBy: PublicKey | null;
};
type ContributionAccount = { amount: BN; claimed: boolean };
type CampaignProposalAccount = { campaign: PublicKey; sha256: number[]; uri: string };
type Accounts = {
  campaign: { fetch(key: PublicKey): Promise<CampaignAccount> };
  milestone: { fetchMultiple(keys: PublicKey[]): Promise<(MilestoneAccount | null)[]> };
  contribution: { fetchNullable(key: PublicKey): Promise<ContributionAccount | null> };
  campaignProposal: { fetchNullable(key: PublicKey): Promise<CampaignProposalAccount | null> };
};
type Methods = Record<string, (...args: unknown[]) => {
  accountsStrict(accounts: Record<string, PublicKey | null>): { transaction(): Promise<Transaction> };
}>;

export type Network = {
  connection: Connection;
  program: Program;
  programId: PublicKey;
  mint: PublicKey;
  devnetCheck?: Promise<void>;
};

export type Client = Network & {
  campaign: PublicKey;
  vault: PublicKey;
  milestones: [PublicKey, PublicKey];
};

const SOLANA_DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM_ID = 'G5TYizzLmGWWbcEYhUgz8pdZupqgHKRkiKszz3UUPaHk';
const DEFAULT_REVIEW_SECONDS = 2 * 24 * 60 * 60;

async function fetchPublicJson(path: string): Promise<unknown | null> {
  const response = await fetch(path, { cache: 'no-cache' });
  if (response.status === 404 || response.ok && response.headers.get('content-type')?.includes('text/html')) return null;
  if (!response.ok) throw new Error('No se pudo cargar la configuración de Devnet.');
  return response.json() as Promise<unknown>;
}

export async function loadNetwork(): Promise<Network | null> {
  const mint = import.meta.env.VITE_SOLANA_MINT;
  if (!mint) return null;
  const idl = await fetchPublicJson(`${import.meta.env.BASE_URL}devnet-idl.json`) as Idl | null;
  const programId = new PublicKey(import.meta.env.VITE_SOLANA_PROGRAM_ID || PROGRAM_ID);
  if (idl?.address !== programId.toBase58() || !idl.instructions.some((ix) => ix.name === 'publish_proposal')) {
    throw new Error('La interfaz del programa de publicación en Devnet está pendiente.');
  }
  const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
  const provider: Provider = { connection };
  return { connection, program: new Program(idl, provider), programId, mint: new PublicKey(mint) };
}

function findAddress(network: Network, name: string, campaign: PublicKey, index?: number) {
  const seeds = [new TextEncoder().encode(name), campaign.toBytes()];
  if (index !== undefined) seeds.push(Uint8Array.of(index));
  return PublicKey.findProgramAddressSync(seeds, network.programId)[0];
}

export function createClient(network: Network, campaignAddress: string): Client {
  const campaign = new PublicKey(campaignAddress);
  return {
    ...network,
    campaign,
    vault: associatedTokenAddress(network.mint, campaign, true),
    milestones: [findAddress(network, 'milestone', campaign, 0), findAddress(network, 'milestone', campaign, 1)],
  };
}

export function deriveCampaign(network: Network, creator: string, nonce: bigint): string {
  return campaignAddress(network.programId, new PublicKey(creator), nonce).toBase58();
}

function verifyDevnet(client: Network) {
  client.devnetCheck ??= client.connection.getGenesisHash().then((genesisHash) => {
    if (genesisHash !== SOLANA_DEVNET_GENESIS_HASH) throw new Error('El RPC configurado no corresponde a Solana Devnet.');
  }).catch((error: unknown) => {
    client.devnetCheck = undefined;
    throw error;
  });
  return client.devnetCheck;
}

const asBigInt = (value: BN) => BigInt(value.toString());
const status = (value: StateEnum) => Object.keys(value)[0];
const fromHash = (value: number[]) => Array.from(value, (n) => n.toString(16).padStart(2, '0')).join('');

function contributionKey(client: Client, signer: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('contribution'), client.campaign.toBytes(), signer.toBytes()],
    client.programId,
  )[0];
}

function normalizeMilestone(raw: MilestoneAccount): Milestone {
  return {
    index: raw.index,
    amount: asBigInt(raw.amount),
    status: status(raw.status),
    deadline: raw.deadline.toNumber(),
    hardDeadline: raw.hardDeadline.toNumber(),
    evidenceVersion: raw.evidenceVersion,
    evidenceHash: fromHash(raw.evidenceHash),
    evidenceUri: raw.evidenceUri,
    graceUsed: raw.graceUsed,
    disputeOpened: raw.disputeOpenedBy !== null,
  };
}

export async function readProgress(client: Client, walletAddress?: string): Promise<Progress> {
  await verifyDevnet(client);
  const accounts = client.program.account as unknown as Accounts;
  const owner = walletAddress ? new PublicKey(walletAddress) : null;
  const [campaign, milestones, contribution, walletTokenAccount] = await Promise.all([
    accounts.campaign.fetch(client.campaign),
    accounts.milestone.fetchMultiple(client.milestones),
    owner ? accounts.contribution.fetchNullable(contributionKey(client, owner)) : null,
    owner ? client.connection.getAccountInfo(associatedTokenAddress(client.mint, owner)).catch(() => undefined) : undefined,
  ]);
  const [first, second] = milestones;
  if (!campaign.mint.equals(client.mint) || !campaign.vault.equals(client.vault)
    || !first || !second || first.index !== 0 || second.index !== 1
    || !first.campaign.equals(client.campaign) || !second.campaign.equals(client.campaign)) {
    throw new Error('Las cuentas de Devnet no coinciden con la campaña publicada.');
  }
  return {
    creator: campaign.creator.toBase58(),
    nonce: asBigInt(campaign.nonce),
    reviewer: campaign.reviewer.toBase58(),
    arbitrator: campaign.arbitrator?.toBase58(),
    activeMilestone: campaign.activeMilestone,
    target: asBigInt(campaign.target),
    contributed: asBigInt(campaign.totalContributed),
    paid: asBigInt(campaign.totalPaid),
    refunded: asBigInt(campaign.totalRefunded),
    refundSnapshot: asBigInt(campaign.refundSnapshot),
    fundingDeadline: campaign.fundingDeadline.toNumber(),
    deliverySeconds: campaign.windows.evidence.toNumber(),
    status: status(campaign.status),
    contributorCount: Number(campaign.contributorCount),
    milestones: [normalizeMilestone(first), normalizeMilestone(second)],
    walletContribution: contribution ? { amount: asBigInt(contribution.amount), claimed: contribution.claimed } : null,
    walletBalance: walletTokenAccount?.owner.equals(TOKEN_PROGRAM_ID) && walletTokenAccount.data.length >= 72
      ? walletTokenAccount.data.readBigUInt64LE(64) : walletTokenAccount === null ? 0n : undefined,
  };
}

async function verifiedPublicDocument(uri: string, expectedHash: string): Promise<unknown> {
  const response = await fetch(publicBlobUrl(uri), { redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('El documento publicado no está disponible.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_PROPOSAL_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > bytes.length) throw new Error('El documento supera el tamaño permitido.');
      bytes.set(value, size);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const contents = bytes.subarray(0, size);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', contents));
  if (Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('') !== expectedHash) {
    throw new Error('El documento publicado cambió y su contenido no coincide con Solana.');
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)) as unknown;
}

export async function readProposal(client: Client, progress: Progress) {
  await verifyDevnet(client);
  const accounts = client.program.account as unknown as Accounts;
  const registered = await accounts.campaignProposal.fetchNullable(findAddress(client, 'proposal', client.campaign));
  if (!registered?.campaign.equals(client.campaign)) throw new Error('Esta campaña aún no tiene una propuesta registrada.');
  const proposal = parseCampaignProposal(await verifiedPublicDocument(registered.uri, fromHash(registered.sha256)));
  if (proposal.campaignId !== client.campaign.toBase58() || proposal.creator !== progress.creator
    || BigInt(proposal.nonce) !== progress.nonce || proposal.reviewer !== progress.reviewer
    || proposal.fundingDeadline !== progress.fundingDeadline || proposal.deliverySeconds !== progress.deliverySeconds
    || proposal.mint !== client.mint.toBase58()
    || proposal.milestones.some((milestone, index) => BigInt(milestone.amount) !== progress.milestones[index].amount)) {
    throw new Error('Los términos publicados no coinciden con los registrados en Solana.');
  }
  return proposal;
}

export async function readEvidence(client: Client, progress: Progress, milestone: Milestone) {
  if (!milestone.evidenceUri || !milestone.evidenceHash) return null;
  const document = parseMilestoneEvidence(await verifiedPublicDocument(milestone.evidenceUri, milestone.evidenceHash));
  if (document.campaignId !== client.campaign.toBase58() || document.creator !== progress.creator
    || document.milestoneIndex !== milestone.index) throw new Error('La evidencia no corresponde a este hito.');
  return document;
}

function vaultDebits(response: VersionedTransactionResponse, outerIndex: number, vaultIndex: number, tokenIndex: number) {
  if (!response.meta?.innerInstructions) return undefined;
  const inner = response.meta?.innerInstructions?.find((entry) => entry.index === outerIndex);
  let amount = 0n;
  for (const transfer of inner?.instructions ?? []) {
    if (transfer.programIdIndex !== tokenIndex || transfer.accounts[0] !== vaultIndex) continue;
    const data = Buffer.from(utils.bytes.bs58.decode(transfer.data));
    if (data.length === 10 && data[0] === 12) amount += data.readBigUInt64LE(1); // SPL TransferChecked
  }
  return amount.toString();
}

function transactionActivity(client: Client, coder: BorshInstructionCoder, signature: string, response: VersionedTransactionResponse) {
  const message = response.transaction.message;
  const keys = message.getAccountKeys({ accountKeysFromLookups: response.meta?.loadedAddresses });
  const findKey = (key: PublicKey) => keys.keySegments().flat().findIndex((candidate) => candidate.equals(key));
  const vaultIndex = findKey(client.vault);
  const tokenIndex = findKey(TOKEN_PROGRAM_ID);
  return message.compiledInstructions.flatMap((instruction, index): Activity[] => {
    if (!keys.get(instruction.programIdIndex)?.equals(client.programId)
      || !keys.get(instruction.accountKeyIndexes[1])?.equals(client.campaign)) return [];
    const decoded = coder.decode(Buffer.from(instruction.data));
    if (!decoded) return [];
    const data = decoded.data as { amount?: BN; index?: number };
    const common = { signature, timestamp: response.blockTime ?? undefined, milestoneIndex: data.index };
    const wallet = keys.get(instruction.accountKeyIndexes[0])?.toBase58();
    switch (decoded.name.replaceAll('_', '').toLowerCase()) {
      case 'contribute':
        return [{ ...common, kind: 'contribution', wallet, amount: data.amount?.toString() }];
      case 'releasemilestone':
        return [{ ...common, kind: 'release', wallet: keys.get(instruction.accountKeyIndexes[4])?.toBase58(),
          amount: vaultDebits(response, index, vaultIndex, tokenIndex) }];
      case 'claimrefund':
        return [{ ...common, kind: 'refund', wallet, amount: vaultDebits(response, index, vaultIndex, tokenIndex) }];
      default:
        return [];
    }
  });
}

export async function readActivity(client: Client): Promise<Activity[]> {
  await verifyDevnet(client);
  const history = await client.connection.getSignaturesForAddress(client.campaign, { limit: 24 }, 'confirmed');
  const signatures = history.filter((entry) => !entry.err).map((entry) => entry.signature);
  if (!signatures.length) return [];
  const transactions = await client.connection.getTransactions(signatures, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const coder = new BorshInstructionCoder(client.program.idl);
  return transactions.flatMap((transaction, index) => transaction ? transactionActivity(client, coder, signatures[index], transaction) : []);
}

function prepareTransaction(client: Client, signer: PublicKey, progress: Progress, action: Action) {
  const methods = client.program.methods as unknown as Methods;
  const { campaign, milestones, mint, vault } = client;
  const contribution = contributionKey(client, signer);
  const tokenProgram = TOKEN_PROGRAM_ID;
  const systemProgram = SystemProgram.programId;
  const associatedTokenProgram = ASSOCIATED_TOKEN_PROGRAM_ID;
  const ata = (owner: PublicKey) => associatedTokenAddress(mint, owner);
  const variant = (decision: string) => ({ [decision]: {} });
  const milestone = 'index' in action ? milestones[action.index] : milestones[0];
  const finalize = () => methods.finalizeFunding().accountsStrict({ campaign, firstMilestone: milestones[0] }).transaction();
  const review = (index: number, version: number, decision: string) => methods.reviewMilestone(index, version, variant(decision))
    .accountsStrict({ reviewer: signer, campaign, milestone }).transaction();
  const release = (index: number) => {
    const recipient = new PublicKey(progress.creator);
    return methods.releaseMilestone(index).accountsStrict({
      executor: signer, campaign, milestone, nextMilestone: index === 0 ? milestones[1] : null,
      recipient, destination: associatedTokenAddress(mint, recipient, true), mint, vault,
      tokenProgram, associatedTokenProgram, systemProgram,
    }).transaction();
  };
  switch (action.kind) {
    case 'contribute': {
      const deposit = methods.contribute(new BN(action.amount.toString())).accountsStrict({
        contributor: signer, campaign, contribution, mint, source: ata(signer), vault, tokenProgram, systemProgram,
      }).transaction();
      // Complete funding in the same signature when this contribution closes the goal.
      return progress.contributed + action.amount === progress.target
        ? Promise.all([deposit, finalize()]).then((instructions) => new Transaction().add(...instructions))
        : deposit;
    }
    case 'finalize':
      return finalize();
    case 'submit':
      return methods.submitEvidence(action.index, Array.from(Buffer.from(action.hash, 'hex')), action.uri).accountsStrict({
        creator: signer, campaign, milestone,
      }).transaction();
    case 'append':
      return methods.appendDisputeEvidence(action.index, Array.from(Buffer.from(action.hash, 'hex')), action.uri).accountsStrict({
        contributor: signer, campaign, milestone, contribution,
      }).transaction();
    case 'review':
      return review(action.index, action.version, action.decision);
    case 'approveAndRelease':
      return Promise.all([review(action.index, action.version, 'approve'), release(action.index)])
        .then((instructions) => new Transaction().add(...instructions));
    case 'advance':
      return methods.advanceExpired(action.index).accountsStrict({ campaign, milestone }).transaction();
    case 'release':
      return release(action.index);
    case 'refund':
      return methods.claimRefund().accountsStrict({
        contributor: signer, campaign, contribution, mint, vault, destination: ata(signer),
        tokenProgram, associatedTokenProgram, systemProgram,
      }).transaction();
    case 'object':
      return methods.openDispute(action.index).accountsStrict({ contributor: signer, campaign, milestone, contribution }).transaction();
    case 'resolve':
      return methods.resolveDispute(action.index, action.version, variant(action.decision)).accountsStrict({
        arbitrator: signer, campaign, milestone,
      }).transaction();
  }
}

type CreateCampaign = {
  creator: string;
  nonce: bigint;
  target: bigint;
  amounts: [bigint, bigint];
  fundingDeadline: number;
  deliverySeconds: number;
  reviewer: string;
  proposal: { sha256: string; uri: string };
};

export async function createCampaign(
  network: Network, wallet: BrowserWallet, terms: CreateCampaign, onSend: (pending: PendingSignature) => void,
) {
  const creator = wallet.publicKey;
  if (!creator || creator.toBase58() !== terms.creator) throw new Error('Reconecta la wallet del equipo que preparó la propuesta.');
  const reviewer = new PublicKey(terms.reviewer);
  if (creator.equals(reviewer) || !PublicKey.isOnCurve(reviewer.toBytes())) throw new Error('Elige una wallet distinta para el revisor.');
  if (!Number.isSafeInteger(terms.fundingDeadline) || terms.fundingDeadline <= Math.floor(Date.now() / 1000)
    || !Number.isSafeInteger(terms.deliverySeconds) || terms.deliverySeconds < 1 || terms.deliverySeconds > MAX_WINDOW_SECONDS) {
    throw new Error('Revisa las fechas de recaudación y entrega.');
  }
  if (!/^[a-f0-9]{64}$/.test(terms.proposal.sha256)) throw new Error('No se pudo verificar el hash de la propuesta.');
  const uri = publicBlobUrl(terms.proposal.uri);
  await verifyDevnet(network);
  const [programAccount, mintAccount] = await network.connection.getMultipleAccountsInfo([network.programId, network.mint]);
  if (!programAccount?.executable) throw new Error('El programa de publicación todavía no está activo en Devnet.');
  if (!mintAccount?.owner.equals(TOKEN_PROGRAM_ID) || mintAccount.data.length !== 82
    || mintAccount.data[44] !== 0 || mintAccount.data[45] !== 1 || mintAccount.data.readUInt32LE(46) !== 0) {
    throw new Error('El token de prueba configurado debe ser SPL, sin decimales y sin autoridad de congelamiento.');
  }

  const client = createClient(network, deriveCampaign(network, creator.toBase58(), terms.nonce));
  const { campaign, milestones, vault, mint } = client;
  const systemProgram = SystemProgram.programId;
  const methods = client.program.methods as unknown as Methods;
  const review = new BN(DEFAULT_REVIEW_SECONDS);
  const [create, publish] = await Promise.all([
    methods.createCampaign(
      new BN(terms.nonce.toString()), new BN(terms.target.toString()), terms.amounts.map((amount) => new BN(amount.toString())),
      new BN(terms.fundingDeadline), { evidence: new BN(terms.deliverySeconds), review, grace: review, objection: review, resolution: review },
      reviewer, null,
    ).accountsStrict({
      creator, campaign, firstMilestone: milestones[0], secondMilestone: milestones[1], vault, mint, systemProgram,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).transaction(),
    methods.publishProposal(Array.from(Buffer.from(terms.proposal.sha256, 'hex')), uri).accountsStrict({
      creator, campaign, proposal: findAddress(network, 'proposal', campaign), systemProgram,
    }).transaction(),
  ]);
  await submitWalletTransaction(network, wallet, creator, new Transaction().add(create, publish), onSend);
  return campaign.toBase58();
}

async function submitWalletTransaction(
  network: Network, wallet: BrowserWallet, signer: PublicKey, transaction: Transaction, onSend: (pending: PendingSignature) => void,
) {
  if (!wallet.publicKey?.equals(signer)) throw new Error('La wallet cambió. Conéctala de nuevo.');
  const block = await network.connection.getLatestBlockhash('confirmed');
  transaction.feePayer = signer;
  transaction.recentBlockhash = block.blockhash;
  const signed = await wallet.signTransaction(transaction);
  if (!signed.signature) throw new Error('La wallet no devolvió la firma requerida.');
  const serialized = signed.serialize();
  const signature = utils.bytes.bs58.encode(signed.signature);
  onSend({ signature, lastValidBlockHeight: block.lastValidBlockHeight });
  await network.connection.sendRawTransaction(serialized, { preflightCommitment: 'confirmed' });
  const result = await network.connection.confirmTransaction({ signature, ...block }, 'confirmed');
  if (result.value.err) throw new Error('Solana rechazó la transacción. Revisa el movimiento antes de volver a firmar.');
  return signature;
}

export async function sendAction(
  client: Client, wallet: BrowserWallet, address: string, progress: Progress, action: Action, onSend: (pending: PendingSignature) => void,
) {
  await verifyDevnet(client);
  const signer = new PublicKey(address);
  return submitWalletTransaction(client, wallet, signer, await prepareTransaction(client, signer, progress, action), onSend);
}

export async function readPendingSignature(client: Network, pending: PendingSignature) {
  await verifyDevnet(client);
  const { value: [record] } = await client.connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
  if (record?.err) return 'rejected';
  if (record?.confirmationStatus === 'confirmed' || record?.confirmationStatus === 'finalized') return 'confirmed';
  if (record) return 'pending';
  return await client.connection.getBlockHeight('confirmed') > pending.lastValidBlockHeight ? 'expired' : 'pending';
}

export function explainError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancelled|4001/i.test(message)) return 'La firma se canceló en tu wallet.';
  if (/insufficient|0x1\b/i.test(message)) return 'Verifica tu saldo del token de prueba y tu SOL de Devnet para la comisión.';
  if (/blockhash|block height|expired|deadline/i.test(message)) return 'El plazo o el bloque cambió. Actualiza la campaña antes de volver a firmar.';
  if (/429|failed to fetch|network|websocket/i.test(message)) return 'Devnet está temporalmente inaccesible. Actualiza la lectura antes de volver a firmar.';
  if (/instruction|account|constraint/i.test(message)) return 'Solana rechazó la acción. Revisa el estado actual, el rol de la wallet y los plazos.';
  return message;
}
