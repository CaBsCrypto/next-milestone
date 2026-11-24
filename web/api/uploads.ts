import { issueSignedToken, presignUrl } from '@vercel/blob';
import { MAX_VIDEO_BYTES } from '../shared/proposal.ts';
import { errorResponse, jsonResponse, methodNotAllowed, requestJson } from '../server/apiResponses.ts';
import {
  ApiError, asObject, authorizeEvidence, challengeSecret, issueChallenge, isUploadScope, mediaPath,
  parseScope, requestOrigin, storageConfigured, verifyChallenge,
} from '../server/uploadAuth.ts';

const VIDEO_CONTENT_TYPES = ['video/mp4'];
const UPLOAD_LIFETIME = 20 * 60 * 1_000;

async function post(request: Request): Promise<Response> {
  try {
    const origin = requestOrigin(request);
    const secret = challengeSecret();
    const body = asObject(await requestJson(request));
    if (body.type === 'challenge') return jsonResponse(issueChallenge(parseScope(body.scope), origin, secret));
    if (body.type !== 'authorize-upload') throw new ApiError(400, 'La operación de carga no es válida.');
    const { scope, id } = verifyChallenge(body.authorization, origin, secret);
    if (!isUploadScope(scope)) throw new ApiError(403, 'La firma no autoriza la carga de un video.');
    await authorizeEvidence(scope);
    const pathname = mediaPath(scope, id);
    const validUntil = Date.now() + UPLOAD_LIFETIME;
    const constraints = { allowedContentTypes: VIDEO_CONTENT_TYPES, maximumSizeInBytes: MAX_VIDEO_BYTES, validUntil };
    const token = await issueSignedToken({ pathname, operations: ['put'], ...constraints });
    const { presignedUrl } = await presignUrl(token, {
      ...constraints, pathname, access: 'public', operation: 'put', allowOverwrite: false, addRandomSuffix: false,
    });
    return jsonResponse({ presignedUrl });
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  fetch(request: Request): Response | Promise<Response> {
    if (request.method === 'GET') return jsonResponse({ configured: storageConfigured() });
    if (request.method === 'POST') return post(request);
    return methodNotAllowed('GET, POST');
  },
};
