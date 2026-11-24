import { createHash } from 'node:crypto';
import { BlobNotFoundError, head, put } from '@vercel/blob';
import { MAX_PROPOSAL_BYTES, MAX_VIDEO_BYTES, publicBlobUrl } from '../shared/proposal.ts';
import { readLimitedBody } from './apiResponses.ts';
import { ApiError, mediaPrefix, type UploadScope } from './uploadAuth.ts';

const MIME_TYPE = 'video/mp4';

type VideoStore = Pick<typeof globalThis, 'fetch'> & { head: typeof head };

async function videoHeader(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const header = Buffer.alloc(12);
  let offset = 0;
  try {
    while (offset < header.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = value.subarray(0, header.length - offset);
      header.set(part, offset);
      offset += part.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return header.subarray(0, offset);
}

export async function verifyVideoUpload(url: string, scope: UploadScope, store: VideoStore = { head, fetch }): Promise<void> {
  const pathname = new URL(url).pathname.slice(1);
  const prefix = mediaPrefix(scope);
  if (!pathname.startsWith(prefix) || !/^[a-f\d]{32}\.mp4$/.test(pathname.slice(prefix.length))) {
    throw new ApiError(400, 'El video debe haberse subido para esta campaña e hito.');
  }

  // Looking up the pathname scopes verification to our configured Blob store.
  const media = await store.head(pathname).catch((error: unknown) => {
    if (error instanceof BlobNotFoundError) throw new ApiError(400, 'Completa la carga del video antes de publicar.');
    throw error;
  });
  if (publicBlobUrl(media.url) !== url || media.pathname !== pathname || media.contentType !== MIME_TYPE
    || media.size < 12 || media.size > MAX_VIDEO_BYTES) {
    throw new ApiError(400, 'El video debe ser un MP4 de hasta 100 MB subido para esta campaña.');
  }

  const prefixResponse = await store.fetch(media.url, {
    headers: { range: 'bytes=0-11' }, redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (!prefixResponse.ok) throw new ApiError(400, 'Todavía no se puede leer el video. Intenta nuevamente.');
  const bytes = await videoHeader(prefixResponse);
  if (bytes.byteLength !== 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') {
    throw new ApiError(400, 'El archivo no se reconoce como MP4. Vuelve a exportarlo en ese formato.');
  }
}

export function documentDigest(json: string): string {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

export function documentPath(kind: 'proposal' | 'evidence', digest: string): string {
  return `${kind === 'proposal' ? 'p' : 'e'}/${Buffer.from(digest, 'hex').toString('base64url')}.json`;
}

export async function publishDocument(kind: 'proposal' | 'evidence', json: string, digest: string) {
  const pathname = documentPath(kind, digest);
  const body = Buffer.from(json, 'utf8');
  if (body.byteLength > MAX_PROPOSAL_BYTES) throw new ApiError(413, 'El documento supera el tamaño permitido.');
  try {
    const result = await put(pathname, json, {
      access: 'public', contentType: 'application/json; charset=utf-8', allowOverwrite: false, addRandomSuffix: false,
    });
    return { uri: publicBlobUrl(result.url), sha256: digest };
  } catch (writeError) {
    // A concurrent publish or a lost response may have already stored these bytes.
    const existing = await head(pathname).catch(() => null);
    if (!existing || existing.size !== body.byteLength || existing.pathname !== pathname) throw writeError;
    const uri = publicBlobUrl(existing.url);
    const response = await fetch(uri, { redirect: 'error', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw writeError;
    const bytes = await readLimitedBody(response.body, response.headers.get('content-length'), MAX_PROPOSAL_BYTES);
    if (!body.equals(Buffer.from(bytes))) throw writeError;
    return { uri, sha256: digest };
  }
}
