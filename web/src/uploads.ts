import {
  parseMilestoneEvidence, serializeMilestoneEvidence, type MilestoneEvidence,
} from '../shared/evidence.ts';
import { MAX_VIDEO_BYTES, parseCampaignProposal, publicBlobUrl, serializeCampaignProposal, type CampaignProposal } from '../shared/proposal.ts';

type WalletForUploads = {
  publicKey: { toBase58(): string } | null;
  signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
};
type CampaignDraft = { campaignId: string; nonce: string };
type EvidenceDraft = CampaignDraft & { milestoneIndex: number };
type UploadOptions = { signal?: AbortSignal; onProgress?: (percentage: number) => void };
type Challenge = { ticket: string; message: string };
type StoredDocument = { uri: string; sha256: string };

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const result = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !result) throw new Error(result?.error || 'La publicación de archivos no está disponible. Intenta nuevamente.');
  return result;
}

function walletAddress(wallet: WalletForUploads): string {
  const address = wallet.publicKey?.toBase58();
  if (!address) throw new Error('Conecta la wallet creadora.');
  return address;
}

async function authorize(wallet: WalletForUploads, scope: Record<string, string | number>, signal?: AbortSignal) {
  if (!wallet.signMessage) throw new Error('Tu wallet debe admitir la firma de mensajes para publicar archivos.');
  const address = walletAddress(wallet);
  const challenge = await postJson<Challenge>('/api/uploads', { type: 'challenge', scope: { ...scope, wallet: address } }, signal);
  if (!challenge.ticket || !challenge.message) throw new Error('No se pudo autorizar la publicación.');
  if (walletAddress(wallet) !== address) throw new Error('La wallet cambió durante la carga.');
  const signed = await wallet.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
  if (walletAddress(wallet) !== address) throw new Error('La wallet cambió durante la firma.');
  const signature = signed instanceof Uint8Array ? signed : signed.signature;
  if (signature.byteLength !== 64) throw new Error('La firma de la wallet no es válida.');
  return { authorization: { ticket: challenge.ticket, signature: btoa(String.fromCharCode(...signature)) } };
}

function uploadToStorage(location: string, file: File, { signal, onProgress }: UploadOptions): Promise<string> {
  const url = new URL(location);
  if (url.origin !== 'https://vercel.com' || url.pathname !== '/api/blob/' || url.username || url.password) {
    throw new Error('El destino de carga no es válido.');
  }
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const fail = () => reject(new Error('La carga se interrumpió. Puedes volver a intentarlo.'));
    request.upload.onprogress = (event) => onProgress?.(Math.min(100, Math.round(100 * event.loaded / file.size)));
    request.onerror = fail;
    request.ontimeout = fail;
    request.onabort = () => reject(new DOMException('Se canceló la carga.', 'AbortError'));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        fail();
        return;
      }
      try {
        resolve(publicBlobUrl(request.response?.url));
      } catch (error) {
        reject(error);
      }
    };
    request.onloadend = () => signal?.removeEventListener('abort', abort);
    request.open('PUT', url.href);
    request.responseType = 'json';
    request.timeout = 20 * 60 * 1_000;
    request.setRequestHeader('Content-Type', 'video/mp4');
    signal?.addEventListener('abort', abort, { once: true });
    try {
      request.send(file);
    } catch (error) {
      signal?.removeEventListener('abort', abort);
      reject(error);
    }
  });
}

async function uploadVideo(wallet: WalletForUploads, scope: Record<string, string | number>, file: File, options: UploadOptions = {}): Promise<string> {
  if (!/\.mp4$/i.test(file.name) || (file.type && file.type !== 'video/mp4') || file.size < 12 || file.size > MAX_VIDEO_BYTES) {
    throw new Error('Selecciona un video MP4 de hasta 100 MB.');
  }
  const { authorization } = await authorize(wallet, scope, options.signal);
  const { presignedUrl } = await postJson<{ presignedUrl: string }>('/api/uploads', {
    type: 'authorize-upload', authorization,
  }, options.signal);
  return uploadToStorage(presignedUrl, file, options);
}

export function uploadCampaignVideo(wallet: WalletForUploads, draft: CampaignDraft, file: File, options?: UploadOptions): Promise<string> {
  return uploadVideo(wallet, { ...draft, operation: 'upload-pitch' }, file, options);
}

export function uploadMilestoneVideo(wallet: WalletForUploads, draft: EvidenceDraft, file: File, options?: UploadOptions): Promise<string> {
  return uploadVideo(wallet, { ...draft, operation: 'upload-evidence' }, file, options);
}

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

function verifiedDocument(result: StoredDocument, expectedHash: string): StoredDocument {
  if (result.sha256 !== expectedHash) throw new Error('El documento almacenado no coincide con el que firmaste.');
  return { uri: publicBlobUrl(result.uri), sha256: expectedHash };
}

export async function storeCampaignProposal(wallet: WalletForUploads, proposal: CampaignProposal): Promise<StoredDocument> {
  const doc = parseCampaignProposal(proposal);
  if (doc.creator !== walletAddress(wallet)) throw new Error('La wallet debe ser la creadora de la propuesta.');
  const digest = await sha256(serializeCampaignProposal(doc));
  const { authorization } = await authorize(wallet, {
    operation: 'publish-proposal', campaignId: doc.campaignId, nonce: doc.nonce, sha256: digest,
  });
  return verifiedDocument(await postJson<StoredDocument>('/api/proposal', {
    kind: 'proposal', document: doc, authorization,
  }), digest);
}

export async function storeMilestoneEvidence(
  wallet: WalletForUploads, { campaignId, nonce, milestoneIndex, note, videoUrl }: EvidenceDraft & { note: string; videoUrl?: string | null },
): Promise<StoredDocument> {
  const doc: MilestoneEvidence = parseMilestoneEvidence({
    schemaVersion: 1, campaignId, creator: walletAddress(wallet), milestoneIndex, note, videoUrl: videoUrl || null,
  });
  const digest = await sha256(serializeMilestoneEvidence(doc));
  const { authorization } = await authorize(wallet, {
    operation: 'publish-evidence', campaignId, nonce, milestoneIndex, sha256: digest,
  });
  return verifiedDocument(await postJson<StoredDocument>('/api/proposal', {
    kind: 'evidence', document: doc, nonce, authorization,
  }), digest);
}
