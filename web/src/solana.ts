import { BN, type Idl, Program, type Provider, utils } from '@anchor-lang/core';
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram, type Transaction } from '@solana/web3.js';
import type { DemoCase, DemoManifest, Milestone, Progress } from './campaign';

export type BrowserWallet = {
  publicKey: PublicKey | null;
  connect(options?: { onlyIfTrusted: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
  on?(event: 'accountChanged' | 'disconnect', listener: (publicKey?: PublicKey) => void): void;
  off?(event: 'accountChanged' | 'disconnect', listener: (publicKey?: PublicKey) => void): void;
};

export type PendingSignature = { signature: string; lastValidBlockHeight: number };

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
type Accounts = {
  campaign: { fetch(key: PublicKey): Promise<CampaignAccount> };
  milestone: { fetchMultiple(keys: PublicKey[]): Promise<(MilestoneAccount | null)[]> };
  contribution: { fetchNullable(key: PublicKey): Promise<ContributionAccount | null> };
};
type Methods = Record<string, (...args: unknown[]) => {
  accountsStrict(accounts: Record<string, PublicKey | null>): { transaction(): Promise<Transaction> };
}>;

export type Client = {
  connection: Connection;
  program: Program;
  programId: PublicKey;
  campaign: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  milestones: PublicKey[];
};

async function fetchPublicJson(path: string): Promise<unknown | null> {
  const response = await fetch(path, { cache: 'no-cache' });
  if (response.status === 404 || response.ok && response.headers.get('content-type')?.includes('text/html')) return null;
  if (!response.ok) throw new Error('No se pudo cargar la configuración de Devnet.');
  return response.json() as Promise<unknown>;
}

export async function loadDemo(): Promise<{ manifest: DemoManifest; idl: Idl } | null> {
  const result = await fetchPublicJson(`${import.meta.env.BASE_URL}demo-manifest.json`);
  if (result === null) return null;
  const manifest = result as DemoManifest;
  if (manifest.schemaVersion !== 1 || manifest.cluster !== 'devnet' || !Array.isArray(manifest.campaigns)) {
    throw new Error('La configuración de la demo tiene un formato incompatible.');
  }
  const idl = await fetchPublicJson(`${import.meta.env.BASE_URL}devnet-idl.json`) as Idl | null;
  if (idl?.address !== manifest.programId) throw new Error('El identificador del programa no coincide con su IDL.');
  return { manifest, idl };
}

export function createClient(manifest: DemoManifest, campaign: DemoCase, idl: Idl): Client {
  const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
  const provider: Provider = { connection };
  const program = new Program(idl, provider);
  return {
    connection,
    program,
    programId: new PublicKey(manifest.programId),
    campaign: new PublicKey(campaign.campaignId),
    mint: new PublicKey(manifest.mint),
    vault: new PublicKey(campaign.vault),
    milestones: campaign.milestones.map((milestone) => new PublicKey(milestone)),
  };
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
  const accounts = client.program.account as unknown as Accounts;
  const [campaign, milestones, contribution] = await Promise.all([
    accounts.campaign.fetch(client.campaign),
    accounts.milestone.fetchMultiple(client.milestones),
    walletAddress ? accounts.contribution.fetchNullable(contributionKey(client, new PublicKey(walletAddress))) : null,
  ]);
  const [first, second] = milestones;
  if (!campaign.mint.equals(client.mint) || !campaign.vault.equals(client.vault)
    || !first || !second || first.index !== 0 || second.index !== 1
    || !first.campaign.equals(client.campaign) || !second.campaign.equals(client.campaign)) {
    throw new Error('Las cuentas de Devnet no coinciden con la campaña publicada.');
  }
  return {
    creator: campaign.creator.toBase58(),
    reviewer: campaign.reviewer.toBase58(),
    arbitrator: campaign.arbitrator?.toBase58(),
    activeMilestone: campaign.activeMilestone,
    target: asBigInt(campaign.target),
    contributed: asBigInt(campaign.totalContributed),
    paid: asBigInt(campaign.totalPaid),
    refunded: asBigInt(campaign.totalRefunded),
    refundSnapshot: asBigInt(campaign.refundSnapshot),
    fundingDeadline: campaign.fundingDeadline.toNumber(),
    status: status(campaign.status),
    contributorCount: Number(campaign.contributorCount),
    milestones: [normalizeMilestone(first), normalizeMilestone(second)],
    walletContribution: contribution ? { amount: asBigInt(contribution.amount), claimed: contribution.claimed } : null,
  };
}

function prepareTransaction(client: Client, signer: PublicKey, progress: Progress, action: Action) {
  const methods = client.program.methods as unknown as Methods;
  const { campaign, milestones, mint, vault } = client;
  const contribution = contributionKey(client, signer);
  const tokenProgram = TOKEN_PROGRAM_ID;
  const systemProgram = SystemProgram.programId;
  const associatedTokenProgram = ASSOCIATED_TOKEN_PROGRAM_ID;
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
  const variant = (decision: string) => ({ [decision]: {} });
  const milestone = 'index' in action ? milestones[action.index] : milestones[0];
  switch (action.kind) {
    case 'contribute':
      return methods.contribute(new BN(action.amount.toString())).accountsStrict({
        contributor: signer, campaign, contribution, mint, source: ata(signer), vault, tokenProgram, systemProgram,
      }).transaction();
    case 'finalize':
      return methods.finalizeFunding().accountsStrict({ campaign, firstMilestone: milestones[0] }).transaction();
    case 'submit':
      return methods.submitEvidence(action.index, Array.from(Buffer.from(action.hash, 'hex')), action.uri).accountsStrict({
        creator: signer, campaign, milestone,
      }).transaction();
    case 'append':
      return methods.appendDisputeEvidence(action.index, Array.from(Buffer.from(action.hash, 'hex')), action.uri).accountsStrict({
        contributor: signer, campaign, milestone, contribution,
      }).transaction();
    case 'review':
      return methods.reviewMilestone(action.index, action.version, variant(action.decision)).accountsStrict({
        reviewer: signer, campaign, milestone,
      }).transaction();
    case 'advance':
      return methods.advanceExpired(action.index).accountsStrict({ campaign, milestone }).transaction();
    case 'release': {
      const recipient = new PublicKey(progress.creator);
      return methods.releaseMilestone(action.index).accountsStrict({
        executor: signer, campaign, milestone, nextMilestone: action.index === 0 ? milestones[1] : null,
        recipient, destination: ata(recipient), mint, vault, tokenProgram, associatedTokenProgram, systemProgram,
      }).transaction();
    }
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

export async function sendAction(
  client: Client, wallet: BrowserWallet, address: string, progress: Progress, action: Action, onSend: (pending: PendingSignature) => void,
) {
  const signer = new PublicKey(address);
  if (!wallet.publicKey?.equals(signer)) throw new Error('La wallet cambió. Conéctala de nuevo.');
  const [transaction, block] = await Promise.all([
    prepareTransaction(client, signer, progress, action),
    client.connection.getLatestBlockhash('confirmed'),
  ]);
  transaction.feePayer = signer;
  transaction.recentBlockhash = block.blockhash;
  const signed = await wallet.signTransaction(transaction);
  if (!signed.signature) throw new Error('La wallet no devolvió la firma requerida.');
  const serialized = signed.serialize();
  const signature = utils.bytes.bs58.encode(signed.signature);
  onSend({ signature, lastValidBlockHeight: block.lastValidBlockHeight });
  await client.connection.sendRawTransaction(serialized, { preflightCommitment: 'confirmed' });
  const result = await client.connection.confirmTransaction({ signature, ...block }, 'confirmed');
  if (result.value.err) throw new Error('Solana rechazó la transacción. Revisa el movimiento antes de volver a firmar.');
  return signature;
}

export async function readPendingSignature(client: Client, pending: PendingSignature) {
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
