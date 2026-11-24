import { useState, type FormEvent } from 'react';
import { FileVideo2 } from 'lucide-react';
import { evidenceLink, formatDeadline, selectVideo, token, type Milestone, type Progress } from './campaign';
import { explainError, type Action, type BrowserWallet } from './solana';
import { storeMilestoneEvidence, uploadMilestoneVideo } from './uploads';

const primary = 'button button-primary';
const secondary = 'button button-secondary';

type ActionsProps = {
  progress: Progress;
  address: string;
  wallet: BrowserWallet;
  campaignId: string;
  now: number;
  busy: boolean;
  allowContribution: boolean;
  execute: (action: Action) => Promise<void>;
};

export function WalletActions({ progress, address, wallet, campaignId, now, busy, allowContribution, execute }: ActionsProps) {
  const [amount, setAmount] = useState('');
  const role = address === progress.creator ? 'Equipo creador' : address === progress.reviewer ? 'Revisor'
    : address === progress.arbitrator ? 'Árbitro' : progress.walletContribution ? 'Aportante' : 'Visitante';
  const submit = (action: Action) => { void execute(action); };
  const label = <p className="role-label">Tu rol <strong>{role}</strong></p>;

  if (progress.status === 'funding') {
    const remainder = progress.target - progress.contributed;
    const canFinalize = now >= progress.fundingDeadline || remainder === 0n;
    const parsed = /^\d{1,20}$/.test(amount) ? BigInt(amount) : 0n;
    const validAmount = parsed > 0n && parsed <= remainder && (progress.walletBalance === undefined || parsed <= progress.walletBalance);
    return (
      <div className="wallet-fields">
        {label}
        {canFinalize ? <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'finalize' })}>{remainder === 0n ? 'Activar primer hito' : 'Finalizar recaudación'}</button>
          : allowContribution ? <form onSubmit={(event) => { event.preventDefault(); if (!busy && validAmount) submit({ kind: 'contribute', amount: parsed }); }}>
            <label className="field">Aporte en tokens de prueba<input inputMode="numeric" pattern="[0-9]+" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={20} required /></label>
            <p className="field-help">Faltan {token(remainder)} tokens para la meta.</p>
            {progress.walletBalance !== undefined && <p className="field-help">Saldo de tu wallet {token(progress.walletBalance)} tokens de prueba.</p>}
            <button className={primary} type="submit" disabled={busy || !validAmount}>Aportar al proyecto</button>
          </form> : <p className="field-help">Podrás aportar cuando se verifique la propuesta de esta campaña.</p>}
      </div>
    );
  }
  if (progress.status === 'refunding') {
    const contribution = progress.walletContribution;
    const refund = progress.contributed ? (contribution?.amount ?? 0n) * progress.refundSnapshot / progress.contributed : 0n;
    return (
      <div className="wallet-fields">
        {label}
        {!contribution ? <p>Conecta la wallet desde la que aportaste para reclamar tu devolución.</p>
          : contribution.claimed ? <p>La devolución de esta wallet ya fue reclamada.</p>
          : <><p>Puedes recuperar {token(refund)} tokens de prueba.</p><button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'refund' })}>Reclamar devolución</button></>}
      </div>
    );
  }
  if (progress.status !== 'active') return <div className="wallet-fields">{label}<p>La campaña terminó.</p></div>;
  const milestone = progress.milestones[progress.activeMilestone];
  const { index, status, deadline, evidenceVersion } = milestone;
  const expired = deadline > 0 && now >= deadline;
  const link = evidenceLink(milestone.evidenceUri);
  return (
    <div className="wallet-fields">
      {label}
      {status === 'payable' ? <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'release', index })}>Pagar hito al equipo</button>
        : expired ? <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'advance', index })}>Aplicar vencimiento</button>
        : (status === 'executing' || status === 'grace') && role === 'Equipo creador' ? <EvidenceForm key={`${index}-${status}-${evidenceVersion}`} wallet={wallet} campaignId={campaignId} progress={progress} milestone={milestone} busy={busy} execute={execute} />
        : status === 'review' && role === 'Revisor' ? <div className="action-stack">
          {link && <a href={link} className="inline-link" target="_blank" rel="noreferrer">Consultar evidencia registrada</a>}
          <button className={primary} type="button" disabled={busy} onClick={() => submit(progress.arbitrator
            ? { kind: 'review', index, version: evidenceVersion, decision: 'approve' }
            : { kind: 'approveAndRelease', index, version: evidenceVersion })}>{progress.arbitrator ? 'Aprobar evidencia' : 'Aprobar y liberar'}</button>
          {!milestone.graceUsed && <button className={secondary} type="button" disabled={busy} onClick={() => submit({ kind: 'review', index, version: evidenceVersion, decision: 'requestGrace' })}>Pedir subsanación</button>}
        </div>
        : status === 'objection' && !!progress.walletContribution && !milestone.disputeOpened ? <button className={secondary} type="button" disabled={busy} onClick={() => submit({ kind: 'object', index })}>Objetar el hito</button>
        : status === 'resolving' && role === 'Árbitro' ? <div className="action-stack">
          <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'resolve', index, version: evidenceVersion, decision: 'release' })}>Autorizar el pago</button>
          {!milestone.graceUsed && <button className={secondary} type="button" disabled={busy} onClick={() => submit({ kind: 'resolve', index, version: evidenceVersion, decision: 'requestGrace' })}>Pedir subsanación</button>}
          <button className={secondary} type="button" disabled={busy} onClick={() => submit({ kind: 'resolve', index, version: evidenceVersion, decision: 'cancel' })}>Cancelar y habilitar devoluciones</button>
        </div>
        : <p>El hito {index + 1} está en curso.{deadline > 0 && <> El plazo vigente termina el {formatDeadline(deadline)}.</>}</p>}
    </div>
  );
}

function EvidenceForm({ wallet, campaignId, progress, milestone, busy, execute }: { wallet: BrowserWallet; campaignId: string; progress: Progress; milestone: Milestone; busy: boolean; execute: (action: Action) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [savedVideo, setSavedVideo] = useState<{ file: File; url: string } | null>(null);
  const [localStatus, setLocalStatus] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || localStatus || !note.trim() || !wallet.signMessage) return;
    setError('');
    try {
      const scope = { campaignId, nonce: progress.nonce.toString(), milestoneIndex: milestone.index };
      let videoUrl = savedVideo && savedVideo.file === file ? savedVideo.url : undefined;
      if (file && !videoUrl) {
        setLocalStatus('Subiendo evidencia…');
        videoUrl = await uploadMilestoneVideo(wallet, scope, file);
        setSavedVideo({ file, url: videoUrl });
      }
      setLocalStatus('Guardando la evidencia…');
      const evidence = await storeMilestoneEvidence(wallet, { ...scope, note: note.trim(), videoUrl });
      await execute({ kind: 'submit', index: milestone.index, uri: evidence.uri, hash: evidence.sha256 });
    } catch (failure) {
      setError(explainError(failure));
    } finally { setLocalStatus(''); }
  }

  return (
    <form onSubmit={(event) => { void submit(event); }}>
      <label className="field">Evidencia del hito {milestone.index + 1}<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Describe lo que entregaste. Puedes incluir un enlace." maxLength={2000} disabled={busy || !!localStatus} required /></label>
      <label className="upload-field upload-small"><FileVideo2 size={19} aria-hidden="true" /><span><strong>{file?.name || 'Adjuntar video opcional'}</strong><small>MP4 de hasta 100 MB</small></span><input type="file" accept="video/mp4,.mp4" disabled={busy || !!localStatus} onChange={(event) => {
        setError('');
        try { setFile(selectVideo(event.target.files?.[0])); }
        catch (failure) { event.target.value = ''; setError(explainError(failure)); }
      }} /></label>
      {error && <p className="field-error" role="alert">{error}</p>}
      {localStatus && <p className="field-help" role="status">{localStatus}</p>}
      {!wallet.signMessage && <p className="field-help">Usa una wallet que permita autorizar la carga firmando un mensaje.</p>}
      <button className={primary} type="submit" disabled={busy || !!localStatus || !wallet.signMessage}>Presentar evidencia</button>
    </form>
  );
}
