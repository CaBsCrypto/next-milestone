import { PublicKey } from '@solana/web3.js';

export const MAX_VIDEO_BYTES = 100_000_000;
export const MAX_PROPOSAL_BYTES = 65_536;
export const MAX_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const MAX_U64 = (1n << 64n) - 1n;

export type MilestoneProposal = {
  title: string;
  deliverable: string;
  criteria: string;
  amount: string;
};

export type CampaignProposal = {
  schemaVersion: 1;
  campaignId: string;
  creator: string;
  nonce: string;
  title: string;
  team: string;
  speech: string;
  videoUrl: string;
  mint: string;
  reviewer: string;
  fundingDeadline: number;
  deliverySeconds: number;
  milestones: [MilestoneProposal, MilestoneProposal];
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('La ficha de campaña tiene un formato inválido.');
  }
  return value as Record<string, unknown>;
}

function field(value: unknown, label: string, limit: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > limit) throw new Error(`Revisa el campo ${label}.`);
  return normalized;
}

function publicKey(value: unknown, label: string): string {
  try {
    const address = field(value, label, 44);
    if (new PublicKey(address).toBase58() === address) return address;
  } catch {
    // Return a label the creator can match to the form.
  }
  throw new Error(`Revisa la dirección de ${label}.`);
}

export function parseAtomicAmount(value: unknown, allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) {
    throw new Error('Ingresa un monto entero en tokens de prueba.');
  }
  const amount = BigInt(value);
  if (amount > MAX_U64 || amount < (allowZero ? 0n : 1n)) throw new Error('El monto está fuera del rango permitido.');
  return amount;
}

function seconds(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`Revisa ${label}.`);
  }
  return value;
}

export function publicBlobUrl(value: unknown): string {
  if (typeof value === 'string' && value.length <= 256) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname.endsWith('.public.blob.vercel-storage.com')
        && !url.username && !url.password && !url.port && !url.hash && !url.search) return url.href;
    } catch {
      // The proposal must point to an uploaded public file.
    }
  }
  throw new Error('El archivo publicado debe tener una URL válida de almacenamiento.');
}

export function campaignAddress(programId: PublicKey, creator: PublicKey, nonce: bigint): PublicKey {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, nonce, true);
  return PublicKey.findProgramAddressSync([new TextEncoder().encode('campaign'), creator.toBytes(), bytes], programId)[0];
}

function milestone(value: unknown): MilestoneProposal {
  const input = record(value);
  return {
    title: field(input.title, 'título del hito', 100),
    deliverable: field(input.deliverable, 'entregable', 1000),
    criteria: field(input.criteria, 'criterio de aprobación', 1000),
    amount: parseAtomicAmount(input.amount).toString(),
  };
}

export function parseCampaignProposal(value: unknown): CampaignProposal {
  const input = record(value);
  if (input.schemaVersion !== 1 || !Array.isArray(input.milestones) || input.milestones.length !== 2) {
    throw new Error('La ficha debe contener dos hitos y un formato compatible.');
  }
  const creator = publicKey(input.creator, 'creador');
  const reviewer = publicKey(input.reviewer, 'revisor');
  if (creator === reviewer || !PublicKey.isOnCurve(new PublicKey(reviewer).toBytes()) || reviewer === PublicKey.default.toBase58()) {
    throw new Error('El revisor debe ser una wallet distinta del creador.');
  }
  const milestones: CampaignProposal['milestones'] = [milestone(input.milestones[0]), milestone(input.milestones[1])];
  if (BigInt(milestones[0].amount) + BigInt(milestones[1].amount) > MAX_U64) {
    throw new Error('La meta de la campaña está fuera del rango permitido.');
  }
  return {
    schemaVersion: 1,
    campaignId: publicKey(input.campaignId, 'campaña'),
    creator,
    nonce: parseAtomicAmount(input.nonce, true).toString(),
    title: field(input.title, 'título', 100),
    team: field(input.team, 'equipo', 80),
    speech: field(input.speech, 'speech', 10000),
    videoUrl: publicBlobUrl(input.videoUrl),
    mint: publicKey(input.mint, 'token de prueba'),
    reviewer,
    fundingDeadline: seconds(input.fundingDeadline, 'el cierre de la recaudación', 253402300799),
    deliverySeconds: seconds(input.deliverySeconds, 'el plazo de entrega', MAX_WINDOW_SECONDS),
    milestones,
  };
}

export function serializeCampaignProposal(proposal: CampaignProposal): string {
  return JSON.stringify(parseCampaignProposal(proposal));
}
