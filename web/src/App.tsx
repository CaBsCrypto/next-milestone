import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown, ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, Check, CircleAlert, Clapperboard,
  ExternalLink, Link2, LockKeyhole, Plus, RefreshCw, Wallet,
} from 'lucide-react';
import type { CampaignProposal } from '../shared/proposal';
import type { MilestoneEvidence } from '../shared/evidence';
import { campaignUrl, evidenceLink, explorer, formatDeadline, shortAddress, token, type Activity, type Milestone, type Progress } from './campaign';
import { Creator } from './Creator';
import {
  createClient, explainError, isPendingSignature, loadNetwork, readActivity, readEvidence, readPendingSignature, readProgress, readProposal, sendAction,
  type Action, type BrowserWallet, type Client, type Network, type PendingSignature,
} from './solana';
import { WalletActions } from './WalletActions';

type Route = { page: 'home' | 'create' | 'missing' } | { page: 'campaign'; address: string };
type Notice = { text: string; tone: 'pending' | 'success' | 'error'; signature?: string };

const statusLabels: Record<string, string> = {
  funding: 'Recaudando', active: 'En ejecución', refunding: 'En reembolso', completed: 'Completada',
  pending: 'Pendiente', executing: 'En ejecución', review: 'En revisión', objection: 'En objeciones', resolving: 'En disputa',
  grace: 'En subsanación', payable: 'Listo para pagar', paid: 'Pagado', cancelled: 'Cancelado',
};

const movementKinds = {
  contribution: { label: 'Aporte recibido', icon: ArrowDownLeft, prefix: '+', tone: 'in' },
  release: { label: 'Pago al equipo', icon: ArrowUpRight, prefix: '−', tone: 'out' },
  refund: { label: 'Devolución reclamada', icon: ArrowLeftRight, prefix: '−', tone: 'refund' },
};

const protocolMessage = 'La publicación en Devnet estará disponible cuando se configure el programa y su token de prueba.';

function getRoute(): Route {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/crear') return { page: 'create' };
  const campaign = /^\/campanas\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path)?.[1];
  if (campaign) return { page: 'campaign', address: campaign };
  return { page: path === '/' ? 'home' : 'missing' };
}

function loadPending(address: string): PendingSignature | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(`next-milestone:pending:${address}`) ?? 'null') as PendingSignature | null;
    return isPendingSignature(data) ? data : null;
  } catch {
    return null;
  }
}

function useWallet() {
  const [provider, setProvider] = useState<BrowserWallet | null>(() => window.phantom?.solana ?? window.solana ?? null);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    const change = () => { if (active) setAddress(provider.publicKey?.toBase58() ?? ''); };
    const disconnect = () => { if (active) setAddress(''); };
    provider.on?.('accountChanged', change);
    provider.on?.('disconnect', disconnect);
    void provider.connect({ onlyIfTrusted: true }).then(change).catch(() => undefined);
    return () => {
      active = false;
      provider.off?.('accountChanged', change);
      provider.off?.('disconnect', disconnect);
    };
  }, [provider]);

  async function toggle() {
    if (busy) return;
    setError('');
    const wallet = provider ?? window.phantom?.solana ?? window.solana;
    if (!wallet) { setError('Abre Next Milestone con Phantom y activa Solana Devnet para conectar tu wallet.'); return; }
    setBusy(true);
    try {
      if (address) { await wallet.disconnect(); setAddress(''); }
      else setAddress((await wallet.connect()).publicKey.toBase58());
      setProvider(wallet);
    } catch (failure) { setError(explainError(failure)); }
    finally { setBusy(false); }
  }

  return { provider, address, error, busy, toggle };
}

export function App() {
  const route = getRoute();
  const wallet = useWallet();
  const needsNetwork = route.page === 'create' || route.page === 'campaign';
  const [network, setNetwork] = useState<Network | null>(null);
  const [loading, setLoading] = useState(needsNetwork);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!needsNetwork) return;
    let active = true;
    setLoading(true);
    void loadNetwork().then((data) => {
      if (active) setNetwork(data);
    }).catch((failure) => {
      if (active) setLoadError(explainError(failure));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [needsNetwork]);

  useEffect(() => {
    document.title = route.page === 'create' ? 'Crea tu campaña | Next Milestone' : 'Next Milestone | Crowdfunding por hitos';
  }, [route.page]);

  const networkMessage = loadError || (!network && !loading ? protocolMessage : '');
  const connect = () => { void wallet.toggle(); };
  let screen: ReactNode;
  if (route.page === 'create') screen = <Creator network={network} networkMessage={networkMessage} address={wallet.address} wallet={wallet.provider} connect={connect} />;
  else if (route.page === 'campaign') screen = network
    ? <CampaignPage key={route.address} network={network} id={route.address} address={wallet.address} wallet={wallet.provider} connect={connect} />
    : <PageMessage title={loading ? 'Cargando campaña' : 'Campaña en Solana Devnet'} text={loading ? 'Consultando la configuración de la red.' : networkMessage} />;
  else if (route.page === 'missing') screen = <PageMessage title="Página no encontrada" text="En el inicio puedes crear y compartir tu propia campaña." />;
  else screen = <Home />;

  return (
    <>
      <a className="skip-link" href="#contenido">Saltar al contenido</a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="/" aria-label="Inicio de Next Milestone"><img src="/favicon.svg" width="36" height="36" alt="" /><span>Next<span className="brand-accent">Milestone</span></span></a>
          <nav className="main-nav" aria-label="Principal"><a href="/#como-funciona">Cómo funciona</a><a href="/crear" aria-current={route.page === 'create' ? 'page' : undefined}>Crear campaña</a></nav>
          <div className="header-controls"><span className="network"><span />Solana Devnet</span><button className="button button-wallet" type="button" onClick={connect} disabled={wallet.busy} aria-label={wallet.address ? `Desconectar wallet ${wallet.address}` : 'Conectar wallet'}><Wallet size={16} aria-hidden="true" />{wallet.address ? shortAddress(wallet.address) : 'Conectar wallet'}</button></div>
        </div>
      </header>
      {wallet.error && <div className="page-width notice notice-error top-notice" role="alert"><CircleAlert size={17} aria-hidden="true" />{wallet.error}</div>}
      {screen}
      <footer className="site-footer"><div className="page-width"><a href="/">Next Milestone</a><span>Campañas en Solana Devnet</span></div></footer>
    </>
  );
}

const steps = [
  { title: 'Presenta tu proyecto', text: 'Comparte tu video, tu speech y lo que entregarás.', icon: Clapperboard },
  { title: 'Reúne la meta', text: 'Los aportes se guardan en una bóveda en Solana.', icon: LockKeyhole },
  { title: 'Entrega y cobra', text: 'Al aprobar cada entrega, el programa libera ese pago.', icon: Check },
];

function Home() {
  return (
    <main className="page home-page" id="contenido">
      <section className="home-hero">
        <div className="home-copy">
          <span className="product-caption"><span />Crowdfunding en Solana</span>
          <h1>Financia tu proyecto por hitos.</h1>
          <p>Publica lo que quieres construir, reúne aportes de varias personas y cobra a medida que entregas lo comprometido.</p>
          <a href="/crear" className="button button-primary hero-cta"><Plus size={20} aria-hidden="true" />Crear campaña<ArrowRight className="cta-arrow" size={19} aria-hidden="true" /></a>
        </div>
        <section className="flow-panel" id="como-funciona" aria-labelledby="flow-title">
          <div className="flow-heading"><div className="flow-emblem"><LockKeyhole size={21} aria-hidden="true" /></div><h2 id="flow-title">De la propuesta al pago</h2></div>
          <ol className="flow-steps">{steps.map(({ title, text, icon: Icon }, index) => (
            <li key={title}><span className={`flow-icon flow-icon-${index}`}><Icon size={20} strokeWidth={1.9} aria-hidden="true" /></span><div><h3>{title}</h3><p>{text}</p></div></li>
          ))}</ol>
        </section>
      </section>
      <section className="home-rule" aria-labelledby="home-rule-title">
        <div><div className="home-rule-icon"><ArrowDown size={19} aria-hidden="true" /></div><h2 id="home-rule-title">Cada hito tiene un compromiso claro.</h2></div>
        <p>Antes de aportar puedes ver el monto de cada entrega, qué debe demostrar el equipo y quién autoriza el pago. Si termina la campaña con fondos pendientes, puedes reclamar tu parte.</p>
      </section>
    </main>
  );
}

function PageMessage({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <main className="page message-page" id="contenido"><a className="back-link" href="/"><ArrowLeft size={17} aria-hidden="true" />Inicio</a><h1>{title}</h1><p>{text}</p>{action}</main>;
}

function CampaignPage({ network, id, address, wallet, connect }: { network: Network; id: string; address: string; wallet: BrowserWallet | null; connect: () => void }) {
  const client = useMemo(() => {
    try { return createClient(network, id); } catch { return null; }
  }, [network, id]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [proposal, setProposal] = useState<CampaignProposal | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [proposalError, setProposalError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [readFor, setReadFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(() => loadPending(id));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const fetchSequence = useRef(0);
  const position = useRef(address);
  position.current = address;

  const refresh = useCallback(async () => {
    if (!client) return false;
    const sequence = ++fetchSequence.current;
    try {
      const reader = position.current;
      const next = await readProgress(client, reader || undefined);
      if (sequence !== fetchSequence.current) return false;
      setProgress(next);
      setReadFor(reader);
      setReadError('');
      const current = () => sequence === fetchSequence.current;
      await Promise.all([
        readProposal(client, next).then((data) => { if (current()) { setProposal(data); setProposalError(''); } }).catch((failure: unknown) => {
          if (current()) { setProposal(null); setProposalError(explainError(failure)); }
        }),
        readActivity(client).then((data) => { if (current()) { setActivities(data); setHistoryError(''); } }).catch(() => {
          if (current()) setHistoryError('Actualiza la ficha para consultar los movimientos en Solana.');
        }),
      ]);
      return current();
    } catch (failure) {
      if (sequence === fetchSequence.current) setReadError(explainError(failure));
      return false;
    } finally {
      if (sequence === fetchSequence.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) { setLoading(false); return; }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 18_000);
    const clock = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => { fetchSequence.current++; window.clearInterval(timer); window.clearInterval(clock); };
  }, [client, refresh, address]);

  useEffect(() => {
    if (proposal) document.title = `${proposal.title} | Next Milestone`;
  }, [proposal]);

  const remember = useCallback((entry: PendingSignature | null) => {
    setPending(entry);
    try {
      const key = `next-milestone:pending:${id}`;
      if (entry) sessionStorage.setItem(key, JSON.stringify(entry));
      else sessionStorage.removeItem(key);
    } catch { /* The current tab still tracks the transaction. */ }
  }, [id]);

  useEffect(() => {
    if (!client || !pending || busy) return;
    let active = true;
    const check = async () => {
      try {
        const status = await readPendingSignature(client, pending);
        if (!active || status === 'pending' || !await refresh() || !active) return;
        remember(null);
        setNotice({
          tone: status === 'confirmed' ? 'success' : 'error', signature: pending.signature,
          text: status === 'confirmed' ? 'Transacción confirmada.' : status === 'expired' ? 'La firma venció. Ya puedes volver a intentarlo.' : 'Solana rechazó la transacción.',
        });
      } catch { /* Keep the pending action until Devnet responds. */ }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, pending, busy, refresh, remember]);

  async function execute(action: Action) {
    if (!client || !wallet || !address || readFor !== address || !progress || readError || busy || pending) return;
    if (action.kind === 'contribute' && (!proposal || proposalError)) return;
    setBusy(true);
    setNotice({ text: 'Confirma la acción en tu wallet.', tone: 'pending' });
    let signature: string | undefined;
    try {
      if (action.kind === 'contribute') await readProposal(client, progress);
      if (action.kind === 'approveAndRelease' || action.kind === 'review' && action.decision === 'approve') {
        const milestone = progress.milestones[action.index];
        if (!milestone || milestone.evidenceVersion !== action.version || !await readEvidence(client, progress, milestone)) {
          throw new Error('Actualiza el hito y verifica la evidencia registrada antes de aprobar.');
        }
      }
      signature = await sendAction(client, wallet, address, progress, action, (entry) => {
        signature = entry.signature;
        remember(entry);
        setNotice({ text: 'Esperando confirmación de Solana.', tone: 'pending', signature });
      });
      if (await refresh()) remember(null);
      setNotice({ text: 'Transacción confirmada.', tone: 'success', signature });
    } catch (failure) {
      await refresh();
      setNotice({ text: explainError(failure), tone: 'error', signature });
    } finally { setBusy(false); }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(new URL(campaignUrl(id), window.location.origin).href); setCopied(true); }
    catch { setCopied(false); }
  }

  if (!client || !progress) return <PageMessage title={loading ? 'Cargando campaña' : 'Campaña no disponible'} text={loading ? 'Consultando el estado del programa en Solana.' : readError || 'Revisa la dirección en el enlace que recibiste.'} action={client && !loading && <button type="button" className="button button-secondary" onClick={() => { void refresh(); }}>Actualizar</button>} />;

  const completion = progress.target ? Number(progress.contributed * 100n / progress.target) : 0;
  const video = evidenceLink(proposal?.videoUrl ?? '');
  return (
    <main className="page campaign-page" id="contenido">
      <a className="back-link" href="/"><ArrowLeft size={17} aria-hidden="true" />Next Milestone</a>
      {readError && <div className="notice notice-error" role="alert"><CircleAlert size={17} aria-hidden="true" />{readError}</div>}
      {proposalError && <div className="notice notice-error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>La propuesta no pudo verificarse. Los nuevos aportes están pausados. {proposalError}</span></div>}
      <div className="campaign-layout">
        <div className="campaign-content">
          <section className="campaign-intro" aria-labelledby="campaign-title">
            <Status state={progress.status} />
            <h1 id="campaign-title">{proposal?.title || 'Campaña en Solana'}</h1>
            {proposal?.team && <p className="byline">Por {proposal.team}</p>}
            {video && <video className="campaign-video" src={video} controls playsInline preload="metadata" aria-label="Video de la campaña" />}
            {proposal && <p className="speech">{proposal.speech}</p>}
          </section>
          <section className="campaign-milestones" aria-labelledby="milestones-title" id="hitos">
            <h2 id="milestones-title">Hitos de la campaña</h2>
            <ol className="milestone-list">{progress.milestones.map((milestone) => <MilestoneCard key={`${milestone.index}-${milestone.evidenceVersion}-${milestone.evidenceHash}`} client={client} progress={progress} milestone={milestone} details={proposal?.milestones[milestone.index]} />)}</ol>
          </section>
          <section className="movement-section" aria-labelledby="movements-title" id="movimientos">
            <div><h2 id="movements-title">Movimientos en Solana</h2><a className="inline-link" href={explorer('address', id)} target="_blank" rel="noreferrer">Ver historial en Explorer <ExternalLink size={14} aria-hidden="true" /></a></div>
            {historyError && <p className="field-help" role="status">{historyError}</p>}
            {activities.length ? <ul className="movement-list">{activities.map((activity, index) => <Movement key={`${activity.signature}-${activity.kind}-${index}`} activity={activity} />)}</ul> : <p className="field-help">Los aportes, pagos y devoluciones confirmados aparecerán aquí.</p>}
          </section>
        </div>
        <aside className="campaign-sidebar" aria-label="Financiamiento y acciones">
          <section className="funding-card">
            <h2>Meta de financiamiento</h2>
            <div className="funding-amount"><strong>{token(progress.contributed)}</strong><span>de {token(progress.target)} tokens</span></div>
            <progress value={completion} max={100} aria-label="Progreso de recaudación" />
            <div className="funding-progress"><span>{completion}% de la meta</span><span>{progress.contributorCount} {progress.contributorCount === 1 ? 'aportante' : 'aportantes'}</span></div>
            <dl className="funding-details"><div><dt>Pagado al equipo</dt><dd>{token(progress.paid)}</dd></div><div><dt>Devuelto</dt><dd>{token(progress.refunded)}</dd></div><div><dt>En la bóveda</dt><dd>{token(progress.contributed - progress.paid - progress.refunded)}</dd></div></dl>
            <p className="field-help">Cierre de recaudación el {formatDeadline(progress.fundingDeadline)}</p>
            <button type="button" className="button button-secondary copy-link" onClick={() => { void copyLink(); }}>{copied ? <Check size={17} aria-hidden="true" /> : <Link2 size={17} aria-hidden="true" />}{copied ? 'Enlace copiado' : 'Copiar enlace'}</button>
          </section>
          <section className="wallet-card">
            <h2>Tu participación</h2>
            {!address || !wallet ? <><p className="field-help">Conecta una wallet de Devnet para aportar o gestionar tu participación.</p><button type="button" className="button button-primary" onClick={connect}><Wallet size={17} aria-hidden="true" />Conectar wallet</button></>
              : readFor === address ? <WalletActions progress={progress} address={address} wallet={wallet} campaignId={id} now={now} busy={busy || !!pending || !!readError} allowContribution={!!proposal && !proposalError} execute={execute} />
              : <p className="field-help" role="status">Actualizando la participación de tu wallet.</p>}
            {(notice || pending) && <div className={`notice transaction-notice notice-${notice?.tone || 'pending'}`} role="status">{notice?.text || 'Comprobando la firma pendiente.'} {(notice?.signature || pending?.signature) && <a href={explorer('tx', notice?.signature || pending!.signature)} target="_blank" rel="noreferrer">Ver firma</a>}</div>}
          </section>
          <section className="wallet-card roles-card">
            <h2>Responsables</h2><dl><div><dt>Equipo</dt><dd><a href={explorer('address', progress.creator)} target="_blank" rel="noreferrer" title={progress.creator}>{shortAddress(progress.creator)}</a></dd></div><div><dt>Revisor</dt><dd><a href={explorer('address', progress.reviewer)} target="_blank" rel="noreferrer" title={progress.reviewer}>{shortAddress(progress.reviewer)}</a></dd></div></dl>
            <button className="text-button" type="button" onClick={() => { void refresh(); }}><RefreshCw size={14} aria-hidden="true" />Actualizar estado</button>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Status({ state }: { state: string }) {
  return <span className={`status status-${state}`}>{statusLabels[state] ?? 'En consulta'}</span>;
}

function MilestoneCard({ client, progress, milestone, details }: { client: Client; progress: Progress; milestone: Milestone; details?: CampaignProposal['milestones'][number] }) {
  const [evidence, setEvidence] = useState<MilestoneEvidence | null>(null);
  const [error, setError] = useState(false);
  const fingerprint = `${milestone.index}:${milestone.evidenceVersion}:${milestone.evidenceHash}:${milestone.evidenceUri}`;
  useEffect(() => {
    if (!milestone.evidenceVersion) return;
    let active = true;
    void readEvidence(client, progress, milestone).then((value) => {
      if (active) { setEvidence(value); setError(!value); }
    }).catch(() => { if (active) { setEvidence(null); setError(true); } });
    return () => { active = false; };
  // The fingerprint names the exact on-chain evidence revision.
  }, [client, fingerprint]);
  const video = evidenceLink(evidence?.videoUrl ?? '');
  return (
    <li className="milestone-card">
      <span className={`milestone-number ${milestone.status === 'paid' ? 'milestone-done' : ''}`}>{milestone.status === 'paid' ? <Check size={18} aria-hidden="true" /> : milestone.index + 1}</span>
      <div className="milestone-body">
        <div className="milestone-heading"><h3>{details?.title || `Hito ${milestone.index + 1}`}</h3><Status state={milestone.status} /></div>
        {details && <><p>{details.deliverable}</p><p className="milestone-criteria"><strong>Criterio de aprobación</strong> {details.criteria}</p></>}
        {milestone.deadline > 0 && <p className="field-help">Plazo vigente hasta el {formatDeadline(milestone.deadline)}</p>}
        {milestone.status === 'pending' && progress.deliverySeconds >= 86400 && <p className="field-help">Entrega dentro de {Math.floor(progress.deliverySeconds / 86400)} días desde su activación.</p>}
        {evidence && <div className="milestone-evidence"><strong>Evidencia de entrega</strong><p>{evidence.note}</p>{video && <video src={video} controls playsInline preload="metadata" aria-label={`Evidencia del hito ${milestone.index + 1}`} />}</div>}
        {error && <p className="field-help">La evidencia registrada está pendiente de verificación.</p>}
      </div>
      <div className="milestone-amount"><strong>{token(milestone.amount)}</strong><span>tokens</span></div>
    </li>
  );
}

function Movement({ activity }: { activity: Activity }) {
  const movement = movementKinds[activity.kind as keyof typeof movementKinds];
  if (!movement) return null;
  const Icon = movement.icon;
  return (
    <li className="movement"><span className={`activity-icon movement-${movement.tone}`}><Icon size={17} aria-hidden="true" /></span><div><strong>{movement.label}</strong>{activity.timestamp && <time dateTime={new Date(activity.timestamp * 1000).toISOString()}>{formatDeadline(activity.timestamp)}</time>}</div><span className="movement-amount">{activity.amount !== undefined && <>{movement.prefix}{token(BigInt(activity.amount))}</>}</span><a className="transaction-link" href={explorer('tx', activity.signature)} target="_blank" rel="noreferrer" aria-label={`Ver transacción de ${movement.label} en Explorer`}><ExternalLink size={16} aria-hidden="true" /></a></li>
  );
}
