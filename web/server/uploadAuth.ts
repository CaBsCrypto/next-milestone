import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { campaignAddress } from '../shared/proposal.ts';

const DEFAULT_PROGRAM_ID = 'G5TYizzLmGWWbcEYhUgz8pdZupqgHKRkiKszz3UUPaHk';
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const CAMPAIGN_DISCRIMINATOR = createHash('sha256').update('account:Campaign').digest().subarray(0, 8);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CHALLENGE_LIFETIME = 5 * 60 * 1000;
const MAX_U64 = 2n ** 64n - 1n;

type CampaignIdentity = { wallet: string; campaignId: string; nonce: string };
export type UploadScope = CampaignIdentity & (
  | { operation: 'upload-pitch' }
  | { operation: 'upload-evidence'; milestoneIndex: number }
);
export type DocumentScope = CampaignIdentity & (
  | { operation: 'publish-proposal'; sha256: string }
  | { operation: 'publish-evidence'; milestoneIndex: number; sha256: string }
);
export type Scope = UploadScope | DocumentScope;
type ChallengeClaims = { scope: Scope; origin: string; id: string; expiresAt: number };

const operationLabels: Record<Scope['operation'], string> = {
  'upload-pitch': 'Subir un video de pitch público',
  'upload-evidence': 'Subir un video de evidencia público',
  'publish-proposal': 'Guardar una propuesta pública',
  'publish-evidence': 'Guardar evidencia pública',
};

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'El formato de los datos no es válido.');
  }
  return value as Record<string, unknown>;
}

function asAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new ApiError(400, 'La dirección de Solana no es válida.');
  }
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new ApiError(400, 'La dirección de Solana no es válida.');
  }
}

export function parseScope(value: unknown): Scope {
  const { operation, wallet, campaignId, nonce, milestoneIndex, sha256 } = asObject(value);
  if (typeof nonce !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(nonce) || BigInt(nonce) > MAX_U64) {
    throw new ApiError(400, 'El identificador de publicación no es válido.');
  }
  const identity = { wallet: asAddress(wallet), campaignId: asAddress(campaignId), nonce };
  switch (operation) {
    case 'upload-pitch':
      return { ...identity, operation };
    case 'upload-evidence':
      return { ...identity, operation, milestoneIndex: parseMilestoneIndex(milestoneIndex) };
    case 'publish-proposal':
      return { ...identity, operation, sha256: parseHash(sha256) };
    case 'publish-evidence':
      return { ...identity, operation, milestoneIndex: parseMilestoneIndex(milestoneIndex), sha256: parseHash(sha256) };
    default:
      throw new ApiError(400, 'La operación de carga no es válida.');
  }
}

export function parseMilestoneIndex(value: unknown): number {
  if (value !== 0 && value !== 1) throw new ApiError(400, 'El hito no es válido.');
  return value;
}

function parseHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[\da-f]{64}$/.test(value)) {
    throw new ApiError(400, 'El hash del documento no es válido.');
  }
  return value;
}

export function mediaPrefix(scope: UploadScope): string {
  const campaign = `campaigns/${scope.campaignId}`;
  return scope.operation === 'upload-pitch' ? `${campaign}/pitch/` : `${campaign}/evidence/${scope.milestoneIndex}/`;
}

export function isUploadScope(scope: Scope): scope is UploadScope {
  return scope.operation === 'upload-pitch' || scope.operation === 'upload-evidence';
}

export function mediaPath(scope: UploadScope, id: string): string {
  return `${mediaPrefix(scope)}${id}.mp4`;
}

export function campaignProgramId(): PublicKey {
  return new PublicKey(process.env.VITE_SOLANA_PROGRAM_ID || DEFAULT_PROGRAM_ID);
}

export function verifyCampaignAddress(scope: Scope, programId = campaignProgramId()): void {
  const wallet = new PublicKey(scope.wallet);
  const campaign = campaignAddress(programId, wallet, BigInt(scope.nonce));
  if (!PublicKey.isOnCurve(wallet.toBytes()) || campaign.toBase58() !== scope.campaignId) {
    throw new ApiError(403, 'La wallet no corresponde a la campaña indicada.');
  }
}

let devnet: { connection: Connection; verified: Promise<void> } | undefined;

async function getDevnet(): Promise<Connection> {
  if (!devnet) {
    const connection = new Connection(process.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    devnet = {
      connection,
      verified: connection.getGenesisHash().then((hash) => {
        if (hash !== DEVNET_GENESIS_HASH) throw new Error('Unexpected Solana genesis hash');
      }).catch((error: unknown) => {
        devnet = undefined;
        throw error;
      }),
    };
  }
  const current = devnet;
  await current.verified;
  return current.connection;
}

export async function authorizeEvidence(scope: Scope): Promise<void> {
  if (scope.operation !== 'upload-evidence' && scope.operation !== 'publish-evidence') return;
  let account;
  try {
    account = await (await getDevnet()).getAccountInfo(new PublicKey(scope.campaignId));
  } catch {
    throw new ApiError(503, 'Devnet no está disponible para verificar la campaña. Intenta nuevamente.');
  }
  if (!account || !account.owner.equals(campaignProgramId()) || account.data.length < 40
    || !account.data.subarray(0, 8).equals(CAMPAIGN_DISCRIMINATOR)
    || !new PublicKey(account.data.subarray(8, 40)).equals(new PublicKey(scope.wallet))) {
    throw new ApiError(403, 'Solo la wallet creadora puede adjuntar evidencia a esta campaña.');
  }
}

export function storageConfigured(): boolean {
  const staticToken = process.env.BLOB_READ_WRITE_TOKEN;
  const hasStorage = staticToken || process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN;
  return Boolean(hasStorage && (process.env.UPLOAD_CHALLENGE_SECRET || staticToken));
}

export function challengeSecret(): Buffer {
  const secret = process.env.UPLOAD_CHALLENGE_SECRET || process.env.BLOB_READ_WRITE_TOKEN;
  if (!secret || !storageConfigured()) throw new ApiError(503, 'El almacenamiento de campañas todavía no está configurado.');
  return createHmac('sha256', secret).update('next-milestone:upload-challenge:v1').digest();
}

function signTicket(encoded: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(encoded).digest();
}

function challengeMessage(claims: ChallengeClaims): string {
  const { scope, origin, id, expiresAt } = claims;
  const authorization = isUploadScope(scope) ? mediaPath(scope, id) : `SHA-256 ${scope.sha256}`;
  return [
    'Next Milestone · Solana Devnet',
    `Sitio: ${origin}`,
    `Operación: ${operationLabels[scope.operation]}`,
    `Wallet: ${scope.wallet}`,
    `Campaña: ${scope.campaignId}`,
    `Autorización: ${authorization}`,
    `Solicitud: ${id}`,
    `Vence: ${new Date(expiresAt).toISOString()}`,
  ].join('\n');
}

export function issueChallenge(scope: Scope, origin: string, secret: Buffer, now = Date.now()) {
  verifyCampaignAddress(scope);
  const claims: ChallengeClaims = { scope, origin, id: randomBytes(16).toString('hex'), expiresAt: now + CHALLENGE_LIFETIME };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return {
    ticket: `${encoded}.${signTicket(encoded, secret).toString('base64url')}`,
    message: challengeMessage(claims),
    ...(isUploadScope(scope) && { pathname: mediaPath(scope, claims.id) }),
  };
}

export function verifyChallenge(value: unknown, origin: string, secret: Buffer, now = Date.now()): ChallengeClaims {
  const { ticket, signature } = asObject(value);
  const invalid = new ApiError(401, 'La autorización de la wallet no es válida o venció.');
  if (typeof ticket !== 'string' || ticket.length > 1024
    || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    throw invalid;
  }
  const [encoded, mac, extra] = ticket.split('.');
  if (!encoded || !mac || extra !== undefined || !/^[\w-]+$/.test(encoded) || !/^[\w-]{43}$/.test(mac)
    || !timingSafeEqual(Buffer.from(mac, 'base64url'), signTicket(encoded, secret))) {
    throw invalid;
  }
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ChallengeClaims;
  if (claims.origin !== origin || now >= claims.expiresAt) throw invalid;
  const wallet = new PublicKey(claims.scope.wallet);
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, wallet.toBuffer()]), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(challengeMessage(claims)), publicKey, Buffer.from(signature, 'base64'))) throw invalid;
  return claims;
}

export function requireSameScope(actual: Scope, expected: Scope): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ApiError(403, 'La firma no corresponde a los datos enviados.');
  }
}

export function requestOrigin(request: Request): string {
  const origin = new URL(request.url).origin;
  const supplied = request.headers.get('origin');
  if (supplied && supplied !== origin) throw new ApiError(403, 'La solicitud pertenece a otro sitio.');
  return origin;
}
