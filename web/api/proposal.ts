import { parseMilestoneEvidence, serializeMilestoneEvidence } from '../shared/evidence.ts';
import { parseCampaignProposal, serializeCampaignProposal } from '../shared/proposal.ts';
import { errorResponse, jsonResponse, requestJson } from '../server/apiResponses.ts';
import { documentDigest, publishDocument, verifyVideoUpload } from '../server/publishedFiles.ts';
import {
  ApiError, asObject, authorizeEvidence, challengeSecret, parseScope, requestOrigin, requireSameScope, verifyChallenge,
} from '../server/uploadAuth.ts';

function parseDocument<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : 'El documento no es válido.');
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const origin = requestOrigin(request);
    const secret = challengeSecret();
    const body = asObject(await requestJson(request));
    const { scope } = verifyChallenge(body.authorization, origin, secret);

    if (body.kind === 'proposal') {
      const doc = parseDocument(parseCampaignProposal, body.document);
      const identity = { wallet: doc.creator, campaignId: doc.campaignId, nonce: doc.nonce };
      const json = serializeCampaignProposal(doc);
      const sha256 = documentDigest(json);
      requireSameScope(scope, parseScope({ ...identity, operation: 'publish-proposal', sha256 }));
      if (doc.fundingDeadline <= Math.floor(Date.now() / 1_000)) {
        throw new ApiError(400, 'El cierre de la recaudación debe estar en el futuro.');
      }
      await verifyVideoUpload(doc.videoUrl, { ...identity, operation: 'upload-pitch' });
      return jsonResponse(await publishDocument('proposal', json, sha256));
    }

    if (body.kind === 'evidence') {
      const doc = parseDocument(parseMilestoneEvidence, body.document);
      const json = serializeMilestoneEvidence(doc);
      const sha256 = documentDigest(json);
      const identity = { wallet: doc.creator, campaignId: doc.campaignId, nonce: body.nonce, milestoneIndex: doc.milestoneIndex };
      requireSameScope(scope, parseScope({ ...identity, operation: 'publish-evidence', sha256 }));
      await authorizeEvidence(scope);
      if (doc.videoUrl && scope.operation === 'publish-evidence') {
        const { wallet, campaignId, nonce, milestoneIndex } = scope;
        await verifyVideoUpload(doc.videoUrl, { wallet, campaignId, nonce, milestoneIndex, operation: 'upload-evidence' });
      }
      return jsonResponse(await publishDocument('evidence', json, sha256));
    }

    throw new ApiError(400, 'El tipo de documento no es válido.');
  } catch (error) {
    return errorResponse(error);
  }
}
