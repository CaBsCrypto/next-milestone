import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import proposalRoute from '../api/proposal.ts';
import uploadRoute from '../api/uploads.ts';
import { parseMilestoneEvidence, serializeMilestoneEvidence } from '../shared/evidence.ts';
import { campaignAddress } from '../shared/proposal.ts';
import { uploadCampaignVideo } from '../src/uploads.ts';
import { documentDigest, documentPath, verifyVideoUpload } from '../server/publishedFiles.ts';
import {
  campaignProgramId, issueChallenge, mediaPath, parseScope, requireSameScope, verifyChallenge, type Scope,
} from '../server/uploadAuth.ts';

const ORIGIN = 'https://next-milestone.example';
const SECRET = Buffer.from('test-only-secret');
const NOW = 1_800_000_000_000;

test('the public function entrypoints handle health checks and reject unsupported methods', async () => {
  const health = await uploadRoute.fetch(new Request(`${ORIGIN}/api/uploads`));
  equal(health.status, 200);
  equal(typeof (await health.json()).configured, 'boolean');
  const uploadMethod = await uploadRoute.fetch(new Request(`${ORIGIN}/api/uploads`, { method: 'DELETE' }));
  equal(uploadMethod.status, 405);
  equal(uploadMethod.headers.get('allow'), 'GET, POST');
  const proposalMethod = await proposalRoute.fetch(new Request(`${ORIGIN}/api/proposal`));
  equal(proposalMethod.status, 405);
  equal(proposalMethod.headers.get('allow'), 'POST');
});

function wallet() {
  const pair = generateKeyPairSync('ed25519');
  const publicBytes = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { key: new PublicKey(publicBytes), privateKey: pair.privateKey };
}

function campaign() {
  const creator = wallet();
  const nonce = '12837';
  const campaignId = campaignAddress(campaignProgramId(), creator.key, BigInt(nonce)).toBase58();
  return { creator, identity: { wallet: creator.key.toBase58(), campaignId, nonce } };
}

function authorize(scope: Scope, privateKey: KeyObject) {
  const { ticket, message } = issueChallenge(scope, ORIGIN, SECRET, NOW);
  return { ticket, signature: sign(null, Buffer.from(message), privateKey).toString('base64') };
}

test('the creator can authorize one path in the campaign namespace', () => {
  const { creator, identity } = campaign();
  const scope = parseScope({ ...identity, operation: 'upload-pitch' });
  const proof = authorize(scope, creator.privateKey);
  const claims = verifyChallenge(proof, ORIGIN, SECRET, NOW + 1_000);
  deepEqual(claims.scope, scope);
  if (claims.scope.operation !== 'upload-pitch') throw new Error('Expected pitch authorization');
  equal(mediaPath(claims.scope, claims.id), `campaigns/${identity.campaignId}/pitch/${claims.id}.mp4`);
  throws(() => issueChallenge({ ...scope, nonce: '2' }, ORIGIN, SECRET, NOW), /no corresponde/);
});

test('the upload rejects a different signing wallet, origin, or expired grant', () => {
  const { creator, identity } = campaign();
  const scope = parseScope({ ...identity, operation: 'upload-evidence', milestoneIndex: 1 });
  const expiredAt = NOW + 300_000;
  const proof = authorize(scope, creator.privateKey);
  throws(() => verifyChallenge(proof, ORIGIN, SECRET, expiredAt), /venció/);
  throws(() => verifyChallenge(proof, 'https://other.example', SECRET, NOW), /no es válida/);
  throws(() => verifyChallenge(authorize(scope, wallet().privateKey), ORIGIN, SECRET, NOW), /no es válida/);
  throws(() => verifyChallenge({ ...proof, ticket: `${proof.ticket}x` }, ORIGIN, SECRET, NOW), /no es válida/);
});

test('the publishing signature is bound to the exact document hash and scope', () => {
  const { creator, identity } = campaign();
  const scope = parseScope({ ...identity, operation: 'publish-proposal', sha256: '42'.repeat(32) });
  const proof = authorize(scope, creator.privateKey);
  const authenticated = verifyChallenge(proof, ORIGIN, SECRET, NOW).scope;
  requireSameScope(authenticated, scope);
  throws(() => requireSameScope(authenticated, parseScope({ ...scope, sha256: '43'.repeat(32) })), /no corresponde/);
  throws(() => requireSameScope(authenticated, parseScope({ ...identity, operation: 'publish-evidence', sha256: '42'.repeat(32), milestoneIndex: 0 })), /no corresponde/);
});

test('a video reference must match the configured store, object path and MP4 header', async () => {
  const { identity } = campaign();
  const scope = { ...identity, operation: 'upload-pitch' as const };
  const pathname = mediaPath(scope, 'ab'.repeat(16));
  const url = `https://configured.public.blob.vercel-storage.com/${pathname}`;
  const head: Parameters<typeof verifyVideoUpload>[2] = {
    head: async (path) => {
      equal(path, pathname);
      return {
        pathname, url, contentType: 'video/mp4', size: 100_000_000, contentDisposition: 'inline', cacheControl: 'public',
        downloadUrl: `${url}?download=1`, uploadedAt: new Date(), etag: '"example"',
      };
    },
    fetch: async (input, options) => {
      equal(input, url);
      equal(new Headers(options?.headers).get('range'), 'bytes=0-11');
      return new Response(Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]), { status: 206 });
    },
  };
  await verifyVideoUpload(url, scope, head);
  await rejects(verifyVideoUpload(url.replace('/pitch/', '/evidence/0/'), scope, head), /esta campaña/);
  await rejects(verifyVideoUpload(url.replace('configured.', 'other.'), scope, head), /MP4/);
  await rejects(verifyVideoUpload(url, scope, { ...head, fetch: async () => new Response('not-an-mp4!!') }), /no se reconoce/);
});

test('evidence has a canonical document format and its URI fits the Solana instruction', () => {
  const { identity } = campaign();
  const note = '  Entrega aprobable con versión y pruebas.  ';
  const doc = parseMilestoneEvidence({ schemaVersion: 1, campaignId: identity.campaignId, creator: identity.wallet, milestoneIndex: 0, note, videoUrl: null });
  const canonical = serializeMilestoneEvidence(doc);
  equal(JSON.parse(canonical).note, note.trim());
  equal(serializeMilestoneEvidence(parseMilestoneEvidence(JSON.parse(canonical))), canonical);
  const location = `https://0123456789abcdef.public.blob.vercel-storage.com/${documentPath('evidence', documentDigest(canonical))}`;
  equal(Buffer.byteLength(location) <= 160, true);
  throws(() => parseMilestoneEvidence({ ...doc, note: '' }), /Añade un video o una nota/);
});

test('an interrupted browser upload rejects before returning a published video URL', async (testContext) => {
  const { identity, creator } = campaign();
  const controller = new AbortController();
  const file = new File([Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109])], 'pitch.mp4', { type: 'video/mp4' });
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  testContext.after(() => {
    if (prior) Object.defineProperty(globalThis, 'XMLHttpRequest', prior);
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
  });

  class InterruptedRequest {
    upload = {};
    onabort?: () => void;
    onloadend?: () => void;

    open(method: string, target: string) {
      equal(method, 'PUT');
      equal(target, 'https://vercel.com/api/blob/?test=1');
    }

    setRequestHeader() {}

    send(value: File) {
      equal(value, file);
      controller.abort();
    }

    abort() {
      this.onabort?.();
      this.onloadend?.();
    }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: InterruptedRequest });
  const requestedTypes: string[] = [];
  testContext.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    equal(path, '/api/uploads');
    const request = JSON.parse(String(options.body));
    requestedTypes.push(request.type);
    if (request.type === 'challenge') return Response.json({ ticket: 'ticket', message: 'signed test request' });
    equal(request.type, 'authorize-upload');
    return Response.json({ presignedUrl: 'https://vercel.com/api/blob/?test=1' });
  });
  const signingWallet = {
    publicKey: creator.key,
    signMessage: async (message: Uint8Array) => sign(null, message, creator.privateKey),
  };
  await rejects(uploadCampaignVideo(signingWallet, identity, file, { signal: controller.signal }), { name: 'AbortError' });
  deepEqual(requestedTypes, ['challenge', 'authorize-upload']);
});
