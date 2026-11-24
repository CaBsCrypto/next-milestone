import { publicBlobUrl } from './proposal.ts';

export const MAX_EVIDENCE_NOTE = 2_000;

export type MilestoneEvidence = {
  schemaVersion: 1;
  campaignId: string;
  creator: string;
  milestoneIndex: number;
  note: string;
  videoUrl: string | null;
};

export function parseMilestoneEvidence(value: unknown): MilestoneEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('La evidencia no es válida.');
  const { schemaVersion, campaignId, creator, milestoneIndex, note, videoUrl } = value as Record<string, unknown>;
  const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (schemaVersion !== 1 || typeof campaignId !== 'string' || !address.test(campaignId)
    || typeof creator !== 'string' || !address.test(creator) || (milestoneIndex !== 0 && milestoneIndex !== 1)) {
    throw new Error('La evidencia no corresponde a una campaña e hito válidos.');
  }
  if (typeof note !== 'string' || note.trim().length > MAX_EVIDENCE_NOTE) {
    throw new Error(`Escribe una nota de evidencia de hasta ${MAX_EVIDENCE_NOTE} caracteres.`);
  }
  const publishedVideo = videoUrl === null ? null : publicBlobUrl(videoUrl);
  const trimmedNote = note.trim();
  if (!trimmedNote && !publishedVideo) throw new Error('Añade un video o una nota de evidencia.');
  return { schemaVersion, campaignId, creator, milestoneIndex, note: trimmedNote, videoUrl: publishedVideo };
}

export function serializeMilestoneEvidence(document: MilestoneEvidence): string {
  return JSON.stringify(parseMilestoneEvidence(document));
}
