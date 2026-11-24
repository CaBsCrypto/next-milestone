export const demo = {
  title: 'Subtítulos para todas las clases',
  team: 'Equipo Aula Abierta',
  pitch: 'Una herramienta abierta para que más estudiantes puedan seguir las clases grabadas. El equipo ya tiene una demo y busca financiar las siguientes dos entregas.',
  milestones: [
    {
      title: 'Subtítulos sincronizados',
      description: 'Reproducir un clip de clase con subtítulos en español sincronizados y un control para activarlos.',
      amount: 300n,
    },
    {
      title: 'Exportación WebVTT',
      description: 'Descargar los subtítulos generados y comprobar que otro reproductor los puede abrir.',
      amount: 700n,
    },
  ],
  evidenceClip: '/evidence/class-subtitles.mp4',
  captions: '/evidence/class-subtitles.vtt',
};

export type Activity = {
  kind: string;
  signature: string;
  amount?: string;
  wallet?: string;
  milestoneIndex?: number;
};

export type DemoCase = {
  campaignId: string;
  vault: string;
  milestones: [string, string];
  participants: { creator: string; reviewer: string; arbitrator?: string; contributors: string[] };
  activities: Activity[];
  variant: 'expiry' | 'dispute' | 'interactive' | 'funded' | 'sponsor';
  claimOrder?: string[];
};

export type DemoManifest = {
  schemaVersion: 1;
  cluster: 'devnet';
  programId: string;
  mint: string;
  primaryCampaignId: string;
  campaigns: DemoCase[];
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
  status: string;
  contributorCount: number;
  milestones: [Milestone, Milestone];
  walletContribution: { amount: bigint; claimed: boolean } | null;
};

export const preview: Progress = {
  creator: '',
  reviewer: '',
  activeMilestone: 1,
  target: 1000n,
  contributed: 1000n,
  paid: 300n,
  refunded: 700n,
  refundSnapshot: 700n,
  fundingDeadline: 0,
  status: 'refunding',
  contributorCount: 2,
  milestones: demo.milestones.map((milestone, index): Milestone => ({
    index,
    amount: milestone.amount,
    status: index === 0 ? 'paid' : 'cancelled',
    deadline: 0,
    hardDeadline: 0,
    evidenceVersion: index === 0 ? 1 : 0,
    evidenceHash: '',
    evidenceUri: '',
    graceUsed: index === 1,
    disputeOpened: false,
  })) as [Milestone, Milestone],
  walletContribution: null,
};

export const previewActivity: Activity[] = [
  { kind: 'contribution', signature: '', wallet: 'Aportante A', amount: '600' },
  { kind: 'contribution', signature: '', wallet: 'Aportante B', amount: '400' },
  { kind: 'release', signature: '', wallet: demo.team, amount: '300', milestoneIndex: 0 },
  { kind: 'refund', signature: '', wallet: 'Aportante A', amount: '420' },
  { kind: 'refund', signature: '', wallet: 'Aportante B', amount: '280' },
];

export const token = (amount: bigint) => new Intl.NumberFormat('es-CL').format(amount);

export function shortAddress(address: string) {
  return address.length < 30 ? address : `${address.slice(0, 5)}…${address.slice(-5)}`;
}

export function explorer(type: 'address' | 'tx', value: string) {
  return `https://explorer.solana.com/${type}/${encodeURIComponent(value)}?cluster=devnet`;
}

export function evidenceLink(value: string) {
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === 'https:' || url.origin === window.location.origin && url.protocol === 'http:') {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

export function formatDeadline(seconds: number) {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'medium' }).format(seconds * 1000);
}
