import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDownRight, ArrowLeft, ArrowRight, Check, CircleAlert, FileVideo2, LockKeyhole, Wallet } from 'lucide-react';
import { PublicKey } from '@solana/web3.js';
import type { CampaignProposal } from '../shared/proposal';
import { campaignUrl, explorer, formatDeadline, selectVideo, token } from './campaign';
import { createCampaign, createClient, deriveCampaign, explainError, isPendingSignature, readPendingSignature, type BrowserWallet, type Network, type PendingSignature } from './solana';
import { storeCampaignProposal, uploadCampaignVideo } from './uploads';

type DraftMilestone = { title: string; deliverable: string; criteria: string; amount: string };
type Draft = {
  title: string;
  team: string;
  speech: string;
  reviewer: string;
  fundingDeadline: string;
  deliveryDays: string;
  milestones: [DraftMilestone, DraftMilestone];
};
type PendingPublication = PendingSignature & { campaignId: string };
type CreatorProps = { network: Network | null; networkMessage: string; address: string; wallet: BrowserWallet | null; connect: () => void };

const draftKey = 'next-milestone:creator-draft';
const maxU64 = (1n << 64n) - 1n;
const deadlineDefault = () => {
  const date = new Date(Date.now() + 7 * 86_400_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function readDraft(): Draft {
  const milestone = { title: '', deliverable: '', criteria: '', amount: '' };
  const blank: Draft = { title: '', team: '', speech: '', reviewer: '', fundingDeadline: deadlineDefault(), deliveryDays: '7', milestones: [{ ...milestone }, { ...milestone }] };
  try {
    const data = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null') as Draft | null;
    if (!data || typeof data.title !== 'string' || typeof data.team !== 'string' || typeof data.speech !== 'string'
      || typeof data.reviewer !== 'string' || typeof data.fundingDeadline !== 'string' || typeof data.deliveryDays !== 'string'
      || data.milestones?.length !== 2 || !data.milestones.every((entry) => entry && Object.keys(milestone).every((key) => typeof entry[key as keyof DraftMilestone] === 'string'))) return blank;
    return data;
  } catch {
    return blank;
  }
}

function readPublication(address: string): PendingPublication | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(`next-milestone:publish:${address}`) ?? 'null') as PendingPublication | null;
    return isPendingSignature(data) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(data.campaignId) ? data : null;
  } catch {
    return null;
  }
}

const parseAmount = (value: string) => /^\d{1,20}$/.test(value) ? BigInt(value) : 0n;
const randomNonce = () => crypto.getRandomValues(new BigUint64Array(1))[0];

export function Creator({ network, networkMessage, address, wallet, connect }: CreatorProps) {
  const [draft, setDraft] = useState(readDraft);
  const [file, setFile] = useState<File | null>(null);
  const [previewVideo, setPreviewVideo] = useState('');
  const [step, setStep] = useState<'edit' | 'preview'>('edit');
  const [nonce] = useState(randomNonce);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingPublication | null>(null);
  const [uploaded, setUploaded] = useState<{ campaignId: string; file: File; url: string } | null>(null);
  const amounts: [bigint, bigint] = [parseAmount(draft.milestones[0].amount), parseAmount(draft.milestones[1].amount)];
  const target = amounts[0] + amounts[1];
  const fundingDeadline = Math.floor(new Date(draft.fundingDeadline).getTime() / 1000);

  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Draft remains open in this tab. */ }
  }, [draft]);

  useEffect(() => {
    setPending(address ? readPublication(address) : null);
  }, [address]);

  useEffect(() => {
    if (!file) { setPreviewVideo(''); return; }
    const url = URL.createObjectURL(file);
    setPreviewVideo(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const finish = (campaignId: string) => {
    try { sessionStorage.removeItem(draftKey); } catch { /* Storage can be disabled. */ }
    window.location.assign(campaignUrl(campaignId));
  };

  useEffect(() => {
    if (!network || !pending || !address || busy) return;
    let active = true;
    const check = async () => {
      try {
        const state = await readPendingSignature(createClient(network, pending.campaignId), pending);
        if (!active || state === 'pending') return;
        try { sessionStorage.removeItem(`next-milestone:publish:${address}`); } catch { /* Storage can be disabled. */ }
        setPending(null);
        if (state === 'confirmed') finish(pending.campaignId);
        else setError(state === 'expired' ? 'La firma venció. Revisa la propuesta y vuelve a publicar.' : 'Solana rechazó la publicación. Revisa la propuesta y el saldo de tu wallet.');
      } catch {
        // An unresolved signature must be checked before another publication.
      }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [network, pending, address, busy]);

  function update(field: Exclude<keyof Draft, 'milestones'>, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }));
  }

  function updateMilestone(index: number, field: keyof DraftMilestone, value: string) {
    setDraft((previous) => {
      const milestones: Draft['milestones'] = [...previous.milestones];
      milestones[index] = { ...milestones[index], [field]: value };
      return { ...previous, milestones };
    });
  }

  function validate(publishing = false) {
    if (!draft.title.trim() || !draft.team.trim() || !draft.speech.trim()) return 'Completa el proyecto, el nombre del equipo y el speech.';
    if (publishing && !file) return 'Selecciona el video MP4 con el que presentarás tu proyecto.';
    if (draft.milestones.some(({ title, deliverable, criteria }) => !title.trim() || !deliverable.trim() || !criteria.trim())) return 'Describe ambas entregas e indica qué debe comprobar el revisor.';
    if (amounts.some((amount) => amount < 1n) || target > maxU64) return 'Indica un monto entero positivo para cada hito y una meta dentro del rango del token.';
    if (!Number.isSafeInteger(fundingDeadline) || fundingDeadline <= Date.now() / 1000) return 'Elige un cierre de recaudación en el futuro.';
    const days = Number(draft.deliveryDays);
    if (!Number.isInteger(days) || days < 1 || days > 30) return 'Indica entre 1 y 30 días para entregar cada hito.';
    try {
      const reviewer = new PublicKey(draft.reviewer.trim());
      if (!PublicKey.isOnCurve(reviewer.toBytes()) || reviewer.equals(PublicKey.default)) return 'Ingresa la wallet de Solana de la persona que revisará los hitos.';
      if (reviewer.toBase58() === address) return 'Designa a una persona que pueda revisar las entregas con su propia wallet.';
    } catch {
      return 'Ingresa una dirección de wallet de Solana válida para el revisor.';
    }
    return '';
  }

  function openPreview(event: FormEvent) {
    event.preventDefault();
    const invalid = validate();
    setError(invalid);
    if (!invalid) { setStep('preview'); window.scrollTo(0, 0); }
  }

  async function publish() {
    if (!wallet || !network || !address || !file || busy || pending) return;
    const invalid = validate(true);
    setError(invalid);
    if (invalid) return;
    try {
      const campaignId = deriveCampaign(network, address, nonce);
      const scope = { campaignId, nonce: nonce.toString() };
      let videoUrl = uploaded?.file === file && uploaded.campaignId === campaignId ? uploaded.url : '';
      if (!videoUrl) {
        setBusy('Subiendo tu video…');
        videoUrl = await uploadCampaignVideo(wallet, scope, file, { onProgress: (value) => setBusy(`Subiendo tu video… ${Math.round(value)}%`) });
        setUploaded({ campaignId, file, url: videoUrl });
      }
      setBusy('Guardando tu propuesta…');
      const proposal: CampaignProposal = {
        schemaVersion: 1, ...scope, creator: address,
        title: draft.title.trim(), team: draft.team.trim(), speech: draft.speech.trim(), videoUrl,
        mint: network.mint.toBase58(), reviewer: draft.reviewer.trim(), fundingDeadline,
        deliverySeconds: Number(draft.deliveryDays) * 86_400,
        milestones: [0, 1].map((index) => ({
          title: draft.milestones[index].title.trim(),
          deliverable: draft.milestones[index].deliverable.trim(),
          criteria: draft.milestones[index].criteria.trim(),
          amount: amounts[index].toString(),
        })) as CampaignProposal['milestones'],
      };
      const record = await storeCampaignProposal(wallet, proposal);
      setBusy('Confirma la publicación en tu wallet…');
      const published = await createCampaign(network, wallet, {
        creator: address, nonce, target, amounts, fundingDeadline, deliverySeconds: proposal.deliverySeconds,
        reviewer: proposal.reviewer, proposal: record,
      }, (entry) => {
        setBusy('Esperando confirmación de Solana…');
        const saved = { campaignId, ...entry };
        setPending(saved);
        try { sessionStorage.setItem(`next-milestone:publish:${address}`, JSON.stringify(saved)); } catch { /* This tab still tracks the signature. */ }
      });
      try { sessionStorage.removeItem(`next-milestone:publish:${address}`); } catch { /* Storage can be disabled. */ }
      finish(published);
    } catch (failure) {
      setError(explainError(failure));
    } finally {
      setBusy('');
    }
  }

  const busyOrPending = !!busy || !!pending;
  const formAlert = error && <div className="notice notice-error" role="alert"><CircleAlert size={17} aria-hidden="true" />{error}</div>;
  const publicationAlert = (busy || pending) && <div className="notice" role="status">{busy || 'Comprobando la publicación en Solana…'} {pending && <a href={explorer('tx', pending.signature)} target="_blank" rel="noreferrer">Ver firma</a>}</div>;
  return (
    <main className="page creator-page" id="contenido">
      <div className="page-intro">
        <a className="back-link" href="/"><ArrowLeft size={17} aria-hidden="true" />Inicio</a>
        <h1>{step === 'preview' ? 'Revisa tu campaña' : 'Crea tu campaña'}</h1>
        <p>{step === 'preview' ? 'Así podrán conocer tu propuesta las personas que reciban el enlace.' : 'Presenta tu proyecto y define qué vas a entregar con los aportes.'}</p>
      </div>
      <div className="creator-layout">
        {step === 'edit' ? (
          <form className="editor-form" onSubmit={openPreview}>
            <fieldset className="editor-section" disabled={busyOrPending}>
              <legend>Propuesta</legend>
              <div className="fields-grid">
                <label className="field">Nombre del proyecto<input value={draft.title} onChange={(event) => update('title', event.target.value)} maxLength={100} required /></label>
                <label className="field">Nombre del equipo<input value={draft.team} onChange={(event) => update('team', event.target.value)} maxLength={80} required /></label>
              </div>
              <label className="field">Speech<textarea value={draft.speech} onChange={(event) => update('speech', event.target.value)} placeholder="¿Qué quieres construir y por qué vale la pena financiarlo?" rows={5} maxLength={10000} required /></label>
              <label className="upload-field">
                <FileVideo2 size={27} aria-hidden="true" />
                <span><strong>{file ? 'Cambiar video' : 'Seleccionar video'}</strong><small>{file?.name || 'Archivo MP4 de hasta 100 MB'}</small></span>
                <input type="file" accept="video/mp4,.mp4" onChange={(event) => {
                  setError('');
                  try { setFile(selectVideo(event.target.files?.[0])); }
                  catch (failure) { event.target.value = ''; setError(explainError(failure)); }
                }} />
              </label>
              {previewVideo && <video className="draft-video" src={previewVideo} controls playsInline preload="metadata" aria-label="Vista previa del video" />}
            </fieldset>
            <fieldset className="editor-section" disabled={busyOrPending}>
              <legend>Hitos</legend>
              {draft.milestones.map((milestone, index) => (
                <div className="editor-milestone" key={index}>
                  <h2>Hito {index + 1}</h2>
                  <div className="fields-grid fields-milestone">
                    <label className="field">Título del hito {index + 1}<input value={milestone.title} onChange={(event) => updateMilestone(index, 'title', event.target.value)} maxLength={100} required /></label>
                    <label className="field">Monto en tokens<input inputMode="numeric" pattern="[0-9]+" value={milestone.amount} onChange={(event) => updateMilestone(index, 'amount', event.target.value)} maxLength={20} required /></label>
                  </div>
                  <label className="field">Entregable<textarea value={milestone.deliverable} onChange={(event) => updateMilestone(index, 'deliverable', event.target.value)} rows={2} maxLength={1000} required /></label>
                  <label className="field">Criterio de aprobación<textarea value={milestone.criteria} onChange={(event) => updateMilestone(index, 'criteria', event.target.value)} rows={2} maxLength={1000} required /></label>
                </div>
              ))}
            </fieldset>
            <fieldset className="editor-section" disabled={busyOrPending}>
              <legend>Recaudación y revisión</legend>
              <div className="fields-grid">
                <label className="field">Cierre de recaudación<input type="datetime-local" value={draft.fundingDeadline} onChange={(event) => update('fundingDeadline', event.target.value)} required /></label>
                <label className="field">Días para cada entrega<input type="number" min={1} max={30} value={draft.deliveryDays} onChange={(event) => update('deliveryDays', event.target.value)} required /></label>
              </div>
              <label className="field">Wallet del revisor<input value={draft.reviewer} onChange={(event) => update('reviewer', event.target.value)} maxLength={44} spellCheck={false} placeholder="Dirección de Solana" required /></label>
              <p className="field-help">El plazo de entrega comienza cuando se activa cada hito. El revisor usa su propia wallet para aprobar las entregas.</p>
            </fieldset>
            {formAlert}{publicationAlert}
            <div className="editor-controls"><button className="button button-primary" type="submit" disabled={busyOrPending}>Previsualizar <ArrowRight size={17} aria-hidden="true" /></button></div>
          </form>
        ) : (
          <section className="preview-panel" aria-label="Vista previa de la campaña">
            <div className="preview-label"><Check size={17} aria-hidden="true" />Vista previa del borrador</div>
            <h2>{draft.title.trim()}</h2><p className="byline">Por {draft.team.trim()}</p>
            {previewVideo ? <video className="draft-video" src={previewVideo} controls playsInline preload="metadata" aria-label="Video de la propuesta" />
              : <div className="preview-empty-video"><FileVideo2 size={28} aria-hidden="true" /><div><strong>Video de presentación</strong><p>Agrega tu archivo MP4 al borrador cuando quieras publicar.</p></div></div>}
            <p className="speech">{draft.speech.trim()}</p>
            <ol className="preview-milestones">{draft.milestones.map((milestone, index) => (
              <li key={index}><div className="preview-milestone-title"><h3>{milestone.title}</h3><strong>{token(amounts[index])} tokens</strong></div><p>{milestone.deliverable}</p><p><strong>Criterio</strong> {milestone.criteria}</p></li>
            ))}</ol>
            {formAlert}{publicationAlert}
            {file && <p className="field-help">El video se guarda como archivo público al iniciar la publicación.</p>}
            <div className="editor-controls">
              <button className="button button-secondary" type="button" onClick={() => { setError(''); setStep('edit'); window.scrollTo(0, 0); }} disabled={busyOrPending}><ArrowLeft size={17} aria-hidden="true" />Editar borrador</button>
              {!address ? <button className="button button-primary" type="button" onClick={connect}><Wallet size={17} aria-hidden="true" />Conectar wallet</button>
                : <button className="button button-primary" type="button" onClick={() => { void publish(); }} disabled={busyOrPending || !network || !file || !wallet?.signMessage}>Publicar en Devnet <ArrowRight size={17} aria-hidden="true" /></button>}
            </div>
            {address && !wallet?.signMessage && <p className="field-help">Usa una wallet que permita autorizar la carga firmando un mensaje.</p>}
          </section>
        )}
        <aside className="creator-summary" aria-label="Resumen del borrador">
          <span className="summary-emblem"><LockKeyhole size={22} aria-hidden="true" /></span>
          <h2>Meta de financiamiento</h2>
          <div className="summary-target"><strong>{token(target)}</strong><span>tokens de prueba</span></div>
          <dl className="draft-amounts">{draft.milestones.map((milestone, index) => <div key={index}><dt>{milestone.title.trim() || `Hito ${index + 1}`}</dt><dd>{token(amounts[index])}</dd></div>)}</dl>
          {Number.isFinite(fundingDeadline) && <p className="summary-date">Cierra el {formatDeadline(fundingDeadline)}</p>}
          <div className="summary-note"><ArrowDownRight size={20} aria-hidden="true" /><p>La entrega comienza al alcanzar la meta. Cada desembolso requiere una aprobación.</p></div>
          {networkMessage && <p className="field-help">{networkMessage}</p>}
        </aside>
      </div>
    </main>
  );
}
