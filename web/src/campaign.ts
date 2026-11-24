import { MAX_VIDEO_BYTES } from '../shared/proposal';

export type Activity = {
  kind: string;
  signature: string;
  amount?: string;
  wallet?: string;
  milestoneIndex?: number;
  timestamp?: number;
};

export type Milestone = {
  index: number;
  amount: bigint;
  status: string;
  deadline: number;
  hardDeadline: number;
  evidenceVersion: number;
  evidenceHash: string;
  evidenceUri: string;
  graceUsed: boolean;
  disputeOpened: boolean;
};

export type Progress = {
  creator: string;
  reviewer: string;
  arbitrator?: string;
  activeMilestone: number;
  target: bigint;
  contributed: bigint;
  paid: bigint;
  refunded: bigint;
  refundSnapshot: bigint;
  fundingDeadline: number;
  deliverySeconds: number;
  status: string;
  contributorCount: number;
  milestones: [Milestone, Milestone];
  walletContribution: { amount: bigint; claimed: boolean } | null;
  walletBalance?: bigint;
  nonce: bigint;
};

const integer = new Intl.NumberFormat('es-CL');
const dateTime = new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' });

export const token = (amount: bigint) => integer.format(amount);

export function shortAddress(address: string) {
  return address.length < 30 ? address : `${address.slice(0, 5)}…${address.slice(-5)}`;
}

export function campaignUrl(address: string) {
  return `/campanas/${encodeURIComponent(address)}`;
}

export function explorer(type: 'address' | 'tx', value: string) {
  return `https://explorer.solana.com/${type}/${encodeURIComponent(value)}?cluster=devnet`;
}

export function evidenceLink(value: string) {
  if (!value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (!url.username && !url.password && (url.protocol === 'https:' || url.origin === window.location.origin && url.protocol === 'http:')) return url.href;
  } catch {
    return null;
  }
  return null;
}

export function formatDeadline(seconds: number) {
  return dateTime.format(seconds * 1000);
}

export function selectVideo(file?: File) {
  if (!file) return null;
  const isMp4 = /\.mp4$/i.test(file.name) && (!file.type || file.type === 'video/mp4');
  if (!isMp4 || file.size < 12 || file.size > MAX_VIDEO_BYTES) {
    throw new Error('Selecciona un video MP4 de hasta 100 MB.');
  }
  return file.type ? file : new File([file], file.name, { type: 'video/mp4' });
}
