import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown, ArrowDownLeft, ArrowDownToLine, ArrowLeftRight, ArrowRight, ArrowUpRight, BadgeCheck, Captions, Check,
  CircleHelp, ExternalLink, Flag, Layers3, LockKeyhole, Play, RefreshCw, Wallet, type LucideIcon,
} from 'lucide-react';
import { demo, evidenceLink, explorer, formatDeadline, preview, previewActivity, shortAddress, token, type Activity, type DemoCase, type DemoManifest, type Progress } from './campaign';
import { createClient, explainError, loadDemo, readPendingSignature, readProgress, sendAction, type Action, type BrowserWallet, type Client, type PendingSignature } from './solana';
import { WalletActions } from './WalletActions';

const campaignStatuses: Record<string, string> = {
  funding: 'Recaudando', active: 'En ejecución', refunding: 'En reembolso', completed: 'Completada',
};

const milestoneStatuses: Record<string, string> = {
  pending: 'Pendiente', executing: 'En ejecución', review: 'En revisión', objection: 'En objeciones', resolving: 'En disputa',
  grace: 'En subsanación', payable: 'Listo para pagar', paid: 'Pagado', cancelled: 'Cancelado',
};

type Setup = { manifest: DemoManifest; campaign: DemoCase; client: Client };

const activityKinds: Record<string, { label: string; icon: LucideIcon; mark: string; color: string }> = {
  contribution: { label: 'Aporte recibido', icon: ArrowDownLeft, mark: '+', color: 'in' },
  release: { label: 'Desembolso del hito', icon: ArrowUpRight, mark: '−', color: 'out' },
  refund: { label: 'Reembolso reclamado', icon: ArrowLeftRight, mark: '−', color: 'refund' },
};

const isTerminal = (progress: Progress) => progress.status === 'completed'
  || progress.status === 'refunding' && progress.refundSnapshot === progress.refunded;

function caseUrl(campaign: string) {
  return `?campaign=${encodeURIComponent(campaign)}`;
}

function readStoredSignature(campaign: string): PendingSignature | null {
  try {
    const raw = sessionStorage.getItem(`next-milestone:pending:${campaign}`);
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingSignature;
    return /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(pending.signature) && Number.isSafeInteger(pending.lastValidBlockHeight) ? pending : null;
  } catch {
    return null;
  }
}

export function App() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [booting, setBooting] = useState(true);
  const [setupError, setSetupError] = useState('');
  const [readError, setReadError] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [walletAddress, setWalletAddress] = useState('');
  const [walletError, setWalletError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSignature | null>(null);
  const [notice, setNotice] = useState<{ text: string; type: 'pending' | 'ok' | 'error'; signature?: string } | null>(null);
  const [extraActivities, setExtraActivities] = useState<Activity[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const wallet = useRef<BrowserWallet | null>(null);
  const readId = useRef(0);
  const addressRef = useRef(walletAddress);
  addressRef.current = walletAddress;

  useEffect(() => {
    let mounted = true;
    void loadDemo().then((loaded) => {
      if (!mounted || !loaded) return;
      const { manifest, idl } = loaded;
      const route = new URLSearchParams(window.location.search).get('campaign');
      const campaign = manifest.campaigns.find((entry) => entry.campaignId === (route || manifest.primaryCampaignId));
      if (!campaign) throw new Error('La dirección de esta campaña no está disponible.');
      setSetup({ manifest, campaign, client: createClient(manifest, campaign, idl) });
      const stored = readStoredSignature(campaign.campaignId);
      if (stored) {
        setPending(stored);
        setNotice({ text: 'Comprobando la firma anterior en Devnet.', type: 'pending', signature: stored.signature });
      }
    }).catch((error: unknown) => {
      if (mounted) setSetupError(explainError(error));
    }).finally(() => {
      if (mounted) setBooting(false);
    });
    return () => { mounted = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!setup) return false;
    const id = ++readId.current;
    try {
      const next = await readProgress(setup.client, addressRef.current);
      if (id === readId.current) {
        setProgress(next);
        setReadError('');
        setNow(Math.floor(Date.now() / 1000));
      }
      return id === readId.current;
    } catch (error) {
      if (id === readId.current) setReadError(explainError(error));
      return false;
    }
  }, [setup]);

  const rememberSignature = useCallback((entry: PendingSignature | null) => {
    if (!setup) return;
    setPending(entry);
    try {
      const key = `next-milestone:pending:${setup.campaign.campaignId}`;
      if (entry) sessionStorage.setItem(key, JSON.stringify(entry));
      else sessionStorage.removeItem(key);
    } catch {
      // Some browsers disable session storage. The current tab still tracks this signature.
    }
  }, [setup]);

  useEffect(() => {
    if (!setup || !pending || busy) return;
    let mounted = true;
    const recheck = async () => {
      try {
        const result = await readPendingSignature(setup.client, pending);
        if (!mounted || result === 'pending') return;
        if (!await refresh() || !mounted) return;
        rememberSignature(null);
        setNotice({
          type: result === 'confirmed' ? 'ok' : 'error', signature: pending.signature,
          text: result === 'confirmed' ? 'Transacción confirmada y campaña actualizada.' : result === 'rejected' ? 'Transacción rechazada. La campaña se actualizó.' : 'La firma anterior venció sin confirmación. La campaña se actualizó.',
        });
      } catch (error) {
        if (mounted) setNotice({ type: 'pending', text: explainError(error), signature: pending.signature });
      }
    };
    void recheck();
    const timer = window.setInterval(() => { void recheck(); }, 5_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [setup, pending, busy, refresh, rememberSignature]);

  const terminal = !!progress && isTerminal(progress);
  useEffect(() => {
    if (setup) void refresh();
    if (!setup || terminal) return;
    const readTimer = window.setInterval(() => { void refresh(); }, 15_000);
    const clock = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => { window.clearInterval(readTimer); window.clearInterval(clock); };
  }, [setup, terminal, refresh, walletAddress]);

  useEffect(() => {
    const provider = window.phantom?.solana ?? window.solana;
    if (!provider) return;
    wallet.current = provider;
    const change = () => {
      setWalletAddress(provider.publicKey?.toBase58() ?? '');
      setProgress((previous) => previous && { ...previous, walletContribution: null });
      setWalletError('');
    };
    provider.on?.('accountChanged', change);
    provider.on?.('disconnect', change);
    void provider.connect({ onlyIfTrusted: true }).then(change).catch(() => undefined);
    return () => {
      provider.off?.('accountChanged', change);
      provider.off?.('disconnect', change);
    };
  }, []);

  const onWallet = async () => {
    if (busy) return;
    setWalletError('');
    const provider = wallet.current ?? window.phantom?.solana ?? window.solana;
    if (!provider) {
      setWalletError('Instala Phantom y selecciona Solana Devnet en su modo de prueba.');
      return;
    }
    wallet.current = provider;
    try {
      if (walletAddress) {
        await provider.disconnect();
        setWalletAddress('');
      } else {
        const result = await provider.connect();
        setWalletAddress(result.publicKey.toBase58());
      }
      setProgress((previous) => previous && { ...previous, walletContribution: null });
    } catch (error) {
      setWalletError(explainError(error));
    }
  };

  const execute = async (action: Action) => {
    if (!setup || !wallet.current || !walletAddress || !progress || readError || busy || pending) return;
    setBusy(true);
    setNotice({ text: 'Confirma la acción en tu wallet.', type: 'pending' });
    let signature: string | undefined;
    try {
      signature = await sendAction(setup.client, wallet.current, walletAddress, progress, action, (entry) => {
        signature = entry.signature;
        rememberSignature(entry);
        setNotice({ text: 'Esperando confirmación de Devnet.', type: 'pending', signature });
      });
      const verified = await refresh();
      if (verified) rememberSignature(null);
      setExtraActivities((previous) => [...previous, actionActivity(action, signature!, walletAddress, progress)]);
      setNotice({
        text: verified ? 'Transacción confirmada y campaña actualizada.' : 'Transacción confirmada. Actualiza la lectura para ver el nuevo estado.',
        type: 'ok', signature,
      });
    } catch (error) {
      await refresh();
      setNotice({ text: explainError(error), type: 'error', signature });
    } finally {
      setBusy(false);
    }
  };

  const isPreview = !booting && !setup && !setupError;
  const shown = progress ?? (isPreview ? preview : null);
  const sponsorCase = setup?.campaign.variant === 'sponsor';
  const recorded = setup ? [...setup.campaign.activities, ...extraActivities] : isPreview ? previewActivity : [];
  const movements = recorded.filter((activity) => Object.hasOwn(activityKinds, activity.kind));
  const networkDetails = setup?.manifest.campaigns.find((campaign) => campaign.variant === 'interactive' && campaign.campaignId !== setup.campaign.campaignId);

  return (
    <>
      <header className="site-header" id="top">
        <div className="header-inner">
          <a className="brand" href="#top" aria-label="Inicio, Next Milestone">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} width="37" height="37" alt="" />
            <span>Next<span className="brand-accent"> Milestone</span></span>
          </a>
          <nav className="main-nav" aria-label="Campaña">
            <a className="current" href="#campana">Campaña</a>
            <a href="#hitos">Hitos</a>
            <a href="#movimientos">Movimientos</a>
          </nav>
          <div className="header-controls">
            <span className="network"><span />Solana Devnet</span>
            <button className="button button-wallet" type="button" onClick={() => void onWallet()} disabled={busy}>
              <Wallet size={17} aria-hidden="true" />
              <span>{walletAddress ? shortAddress(walletAddress) : 'Conectar wallet'}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="page" id="campana">
        {walletError && <p className="banner banner-error" role="status">{walletError} <a href="https://phantom.com/download" target="_blank" rel="noreferrer">Abrir Phantom</a></p>}
        {booting && <p className="banner" role="status">Cargando la configuración de Devnet…</p>}
        {isPreview && <p className="banner preview-banner"><CircleHelp size={17} aria-hidden="true" /> Vista de ejemplo. Los montos ilustran el flujo y aún no tienen transacciones asociadas.</p>}
        {setupError && <p className="banner banner-error" role="alert">{setupError}</p>}
        {readError && <div className="banner banner-error" role="status"><span>{readError} Los movimientos registrados conservan sus enlaces públicos.</span><button type="button" className="text-button" onClick={() => void refresh()}>Actualizar lectura</button></div>}

        <section className="hero" aria-labelledby="campaign-title">
          <div className="hero-copy">
            <div className="campaign-tag"><Flag size={14} aria-hidden="true" /> {sponsorCase ? 'Piloto ficticio de escrow' : 'Campaña ficticia'}</div>
            <h1 id="campaign-title">{demo.title}</h1>
            <p className="pitch">{demo.pitch}</p>
            <div className="hero-actions">
              <a className="button button-primary" href="#movimientos">Ver los movimientos <ArrowDown size={17} aria-hidden="true" /></a>
              {networkDetails && <a className="button button-secondary" href={caseUrl(networkDetails.campaignId)}>Probar en Devnet <ArrowRight size={17} aria-hidden="true" /></a>}
              {setup?.campaign.campaignId !== setup?.manifest.primaryCampaignId && setup && <a className="button button-secondary" href={caseUrl(setup.manifest.primaryCampaignId)}>Ver caso principal</a>}
            </div>
            <div className="creator"><span className="creator-icon" aria-hidden="true">A</span><span>Un proyecto de <strong>{demo.team}</strong></span></div>
          </div>
          <Evidence />
        </section>

        <div className="main-grid">
          <div className="campaign-content">
            <section className="milestones" id="hitos" aria-labelledby="milestone-heading">
              <div className="section-title"><div><h2 id="milestone-heading">Hitos de la campaña</h2><p>Qué se entrega y cuándo se mueve el dinero.</p></div><Layers3 aria-hidden="true" size={24} /></div>
              <ol className="milestone-list">
                {demo.milestones.map((item, index) => {
                  const status = shown?.milestones[index].status;
                  const info = shown?.milestones[index];
                  const approvedEvidence = index === 0 && (isPreview || !!info?.evidenceVersion);
                  const url = info?.evidenceUri ? evidenceLink(info.evidenceUri) : null;
                  return (
                    <li className="milestone" key={item.title}>
                      <div className={`milestone-marker ${status === 'paid' ? 'marker-paid' : status === 'cancelled' ? 'marker-cancelled' : ''}`}>
                        {status === 'paid' ? <Check size={17} aria-label="Pagado" /> : String(index + 1).padStart(2, '0')}
                      </div>
                      <div className="milestone-info">
                        <div className="milestone-title"><h3>{item.title}</h3>{status && <span className={`status status-${status}`}>{milestoneStatuses[status] ?? status}</span>}</div>
                        <p>{item.description}</p>
                        {!!info?.deadline && <p className="deadline">Vence {formatDeadline(info.deadline)}</p>}
                        {approvedEvidence && <a className="inline-link" href="#evidencia">Ver el clip y los subtítulos <ArrowUpRight size={14} aria-hidden="true" /></a>}
                        {url && <a className="inline-link" href={url} target="_blank" rel="noreferrer">Evidencia registrada {info?.evidenceVersion ? `v${info.evidenceVersion}` : ''} <ExternalLink size={13} aria-hidden="true" /></a>}
                        {!!info?.evidenceVersion && !!info.evidenceHash && <details className="evidence-hash"><summary>Huella SHA-256</summary><code>{info.evidenceHash}</code></details>}
                        {status === 'cancelled' && <p className="milestone-note">{setup?.campaign.variant === 'dispute' ? 'La revisión del expediente habilitó la devolución proporcional.' : 'El saldo de este hito quedó disponible para los aportantes.'}</p>}
                      </div>
                      <div className="milestone-amount"><strong>{token(info?.amount ?? item.amount)}</strong><span>tokens de prueba</span></div>
                    </li>
                  );
                })}
              </ol>
            </section>

            <section className="ledger" id="movimientos" aria-labelledby="ledger-heading">
              <div className="section-title"><div><h2 id="ledger-heading">Movimientos de fondos</h2><p>{isPreview ? 'Ejemplo de conciliación de la campaña.' : 'Aportes, desembolsos y devoluciones registrados.'}</p></div><ArrowLeftRight aria-hidden="true" size={23} /></div>
              {movements.length ? <ActivityList activities={movements} campaign={setup?.campaign} /> : <p className="empty-state">Todavía no hay movimientos de fondos para mostrar.</p>}
              {setup && <a className="inline-link all-transactions" href={explorer('address', setup.campaign.campaignId)} target="_blank" rel="noreferrer">Ver la cuenta y su historial en Explorer <ExternalLink size={14} aria-hidden="true" /></a>}
            </section>
          </div>
          <aside className="sidebar" aria-label="Fondos y controles de la campaña">
            <Summary data={shown} stale={!!readError} isPreview={isPreview} />
            {setup && <section className="sidebar-card wallet-card" aria-labelledby="wallet-action-heading">
              <div className="sidebar-title"><Wallet aria-hidden="true" size={21} /><h2 id="wallet-action-heading">Acciones de wallet</h2></div>
              {readError ? <p>Actualiza la lectura para habilitar las acciones.</p> : shown && walletAddress ? <WalletActions progress={shown} address={walletAddress} now={now} busy={busy || !!pending} execute={execute} /> : <p>Conecta una wallet de prueba para firmar acciones permitidas por el programa.</p>}
              {!walletAddress && <button className="button button-secondary" type="button" onClick={() => void onWallet()}>Conectar wallet</button>}
              {setup && <button className="text-button refresh" type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={14} aria-hidden="true" /> Actualizar lectura</button>}
              {notice && <p className={`transaction-notice notice-${notice.type}`} role="status">{notice.text} {notice.signature && <a href={explorer('tx', notice.signature)} target="_blank" rel="noreferrer">Ver firma</a>}</p>}
            </section>}
            <section className="sidebar-card contract-card" aria-labelledby="contract-heading">
              <div className="sidebar-title"><LockKeyhole aria-hidden="true" size={21} /><h2 id="contract-heading">Reglas de los fondos</h2></div>
              <p>La bóveda de Solana paga los hitos aprobados al equipo. Si la campaña se cancela, los aportantes pueden reclamar su parte del saldo pendiente.</p>
              {setup ? <dl className="addresses">
                <Address label="Programa" address={setup.manifest.programId} />
                <Address label="Campaña" address={setup.campaign.campaignId} />
                <Address label="Bóveda" address={setup.campaign.vault} />
                <Address label="Mint de prueba" address={setup.manifest.mint} />
              </dl> : <p className="muted-address">Las direcciones aparecerán al cargar una campaña de Devnet.</p>}
            </section>
          </aside>
        </div>
      </main>

      <footer className="site-footer"><div><span>Next Milestone</span><span>Prototipo de Dev3Pack · Solana Devnet</span></div></footer>
    </>
  );
}

function actionActivity(action: Action, signature: string, address: string, progress: Progress): Activity {
  if (action.kind === 'contribute') return { kind: 'contribution', signature, wallet: address, amount: String(action.amount) };
  if (action.kind === 'release') return { kind: 'release', signature, wallet: progress.creator, amount: String(progress.milestones[action.index].amount), milestoneIndex: action.index };
  if (action.kind === 'refund') {
    const refund = progress.contributed ? (progress.walletContribution?.amount ?? 0n) * progress.refundSnapshot / progress.contributed : 0n;
    return { kind: 'refund', signature, wallet: address, amount: String(refund) };
  }
  return { kind: action.kind, signature, wallet: address };
}

function Evidence() {
  const [showVideo, setShowVideo] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const show = () => setShowVideo(true);
  useEffect(() => {
    if (showVideo) {
      video.current?.focus();
      void video.current?.play().catch(() => undefined);
    }
  }, [showVideo]);
  return (
    <figure className="evidence" id="evidencia">
      <div className="evidence-media">
        {showVideo ? (
          <video ref={video} controls playsInline preload="none" tabIndex={0} aria-label="Clip de clase con subtítulos en español" poster={`${import.meta.env.BASE_URL}evidence/class-subtitles-poster.png`} onError={() => setVideoError(true)}>
            <source src={demo.evidenceClip} type="video/mp4" />
            <track kind="captions" src={demo.captions} srcLang="es" label="Español" default />
          </video>
        ) : (
          <button className="evidence-play" type="button" onClick={show} aria-label="Reproducir el clip del primer hito">
            <img src={`${import.meta.env.BASE_URL}evidence/class-subtitles-poster.png`} width="1280" height="720" alt="" />
            <span className="play-icon"><Play size={24} aria-hidden="true" fill="currentColor" /></span>
          </button>
        )}
      </div>
      <figcaption>
        <span className="evidence-icon"><Captions size={21} aria-hidden="true" /></span>
        <span><strong>Evidencia del primer hito</strong><span>Clip de una clase en inglés con subtítulos en español</span></span>
        <a href={demo.captions} download aria-label="Descargar los subtítulos del clip de prueba"><ArrowDownToLine size={19} aria-hidden="true" /></a>
      </figcaption>
      {videoError && <p role="status" className="video-error">El reproductor no pudo cargar el clip. <a href={demo.evidenceClip}>Abrir el archivo de video</a></p>}
    </figure>
  );
}

function Summary({ data, stale, isPreview }: { data: Progress | null; stale: boolean; isPreview: boolean }) {
  const progress = data ? Math.min(100, Number(data.contributed * 100n / (data.target || 1n))) : 0;
  const balance = data ? data.contributed - data.paid - data.refunded : null;
  const status = data?.status === 'refunding' && balance === 0n ? 'Reembolsada' : data ? campaignStatuses[data.status] : 'Pendiente de lectura';
  return (
    <section className="summary sidebar-card" aria-labelledby="funding-heading">
      <div className="summary-top"><h2 id="funding-heading">Resumen de fondos</h2>{data && <span className="status summary-status">{status}</span>}</div>
      <div className="funded"><strong>{data ? token(data.contributed) : '—'}</strong><span> / {data ? token(data.target) : '1.000'} tokens</span></div>
      <progress className="progress-bar" value={progress} max="100" aria-label="Porcentaje de la meta recaudada" />
      <div className="funded-caption"><span>{data ? `${progress}% de la meta` : status}</span><span>{data ? `${data.contributorCount} ${data.contributorCount === 1 ? 'aportante' : 'aportantes'}` : ''}</span></div>
      <dl className="fund-summary">
        <div><dt><span className="summary-dot paid-dot" />Pagado al equipo</dt><dd>{data ? token(data.paid) : '—'}</dd></div>
        <div><dt><span className="summary-dot refunded-dot" />Reembolsado</dt><dd>{data ? token(data.refunded) : '—'}</dd></div>
        <div className="vault-balance"><dt><span className="summary-dot balance-dot" />Saldo registrado</dt><dd>{balance !== null ? token(balance) : '—'}</dd></div>
      </dl>
      <div className="summary-foot"><BadgeCheck size={16} aria-hidden="true" /> {isPreview ? 'Cifras ilustrativas' : stale ? 'Última lectura disponible' : data ? 'Tokens de prueba en Solana Devnet' : 'Tokens de prueba'}</div>
    </section>
  );
}

function ActivityList({ activities, campaign }: { activities: Activity[]; campaign?: DemoCase }) {
  const labels = new Map<string, string>();
  if (campaign) {
    labels.set(campaign.participants.creator, demo.team);
    campaign.participants.contributors.forEach((address, index) => labels.set(address, `Aportante ${String.fromCharCode(65 + index)}`));
  }
  return (
    <ol className="activity-list">
      {activities.map((item, index) => {
        const kind = activityKinds[item.kind];
        const Glyph = kind.icon;
        const wallet = item.wallet ? labels.get(item.wallet) || shortAddress(item.wallet) : null;
        const amount = item.amount && /^\d+$/.test(item.amount) ? token(BigInt(item.amount)) : null;
        return (
          <li key={item.signature || index} className="activity-row">
            <span className={`activity-icon activity-${kind.color}`}><Glyph size={19} aria-hidden="true" /></span>
            <span className="activity-text"><strong>{kind.label}{item.kind === 'release' && item.milestoneIndex !== undefined ? ` ${item.milestoneIndex + 1}` : ''}</strong><span>{wallet ?? 'Campaña'}</span></span>
            <span className={`activity-amount activity-${kind.color}`}>{amount !== null ? `${kind.mark}${amount}` : '—'}</span>
            {item.signature ? <a className="transaction-link" title="Ver en Solana Explorer" href={explorer('tx', item.signature)} target="_blank" rel="noreferrer" aria-label={`Ver ${kind.label.toLowerCase()}${wallet ? ` de ${wallet}` : ''} en Solana Explorer`}><ExternalLink size={16} aria-hidden="true" /></a> : <span className="transaction-link sample-link" aria-label="Importe ilustrativo">—</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Address({ label, address }: { label: ReactNode; address: string }) {
  return <div><dt>{label}</dt><dd><a title={address} className="inline-link" href={explorer('address', address)} target="_blank" rel="noreferrer">{shortAddress(address)} <ExternalLink size={12} aria-hidden="true" /></a></dd></div>;
}
