import { useState, type FormEvent } from 'react';
import { evidenceLink, formatDeadline, token, type Milestone, type Progress } from './campaign';
import type { Action } from './solana';

const primary = 'button button-primary button-action';
const secondary = 'button button-secondary button-action';

type ActionsProps = {
  progress: Progress;
  address: string;
  now: number;
  busy: boolean;
  execute: (action: Action) => Promise<void>;
};

export function WalletActions({ progress, address, now, busy, execute }: ActionsProps) {
  const [amount, setAmount] = useState('');
  const role = address === progress.creator ? 'Creador' : address === progress.reviewer ? 'Revisor'
    : address === progress.arbitrator ? 'Árbitro' : progress.walletContribution ? 'Aportante' : 'Visitante';
  const submit = (action: Action) => { void execute(action); };
  const label = <p className="role-label">Rol en la campaña <strong>{role}</strong></p>;
  if (progress.status === 'funding') {
    const remainder = progress.target - progress.contributed;
    const canFinalize = now >= progress.fundingDeadline || remainder === 0n;
    const parsed = /^\d{1,20}$/.test(amount) ? BigInt(amount) : 0n;
    return (
      <div className="wallet-fields">
        {label}
        {canFinalize ? <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'finalize' })}>Cerrar recaudación</button>
          : <form onSubmit={(event) => { event.preventDefault(); if (parsed > 0n && parsed <= remainder) submit({ kind: 'contribute', amount: parsed }); }}>
            <label htmlFor="contribution">Aporte en tokens de prueba</label>
            <input id="contribution" inputMode="numeric" pattern="[0-9]+" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={20} required />
            <p>Quedan {token(remainder)} tokens de prueba. La recaudación vence {formatDeadline(progress.fundingDeadline)}.</p>
            <button className={primary} type="submit" disabled={busy || parsed === 0n || parsed > remainder}>Aportar al proyecto</button>
          </form>}
      </div>
    );
  }
  if (progress.status === 'refunding') {
    const contribution = progress.walletContribution;
    const amount = progress.contributed ? (contribution?.amount ?? 0n) * progress.refundSnapshot / progress.contributed : 0n;
    return (
      <div className="wallet-fields">
        {label}
        {!contribution ? <p>Esta wallet carece de un aporte registrado.</p>
          : contribution.claimed ? <p>La devolución de esta wallet ya fue reclamada.</p>
          : <><p>Esta wallet puede recuperar {token(amount)} tokens de prueba.</p><button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'refund' })}>Reclamar devolución</button></>}
      </div>
    );
  }
  if (progress.status !== 'active') return <div className="wallet-fields">{label}<p>La campaña terminó.</p></div>;
  const milestone = progress.milestones[progress.activeMilestone];
  if (!milestone) return <div className="wallet-fields">{label}<p>El programa está actualizando el hito activo.</p></div>;
  const { index, status, deadline, evidenceVersion } = milestone;
  const expired = deadline > 0 && now >= deadline;
  return (
    <div className="wallet-fields">
      {label}
      {status === 'payable' ? <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'release', index })}>Pagar hito al equipo</button>
        : expired ? <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'advance', index })}>Aplicar vencimiento</button>
        : (status === 'executing' || status === 'grace') && role === 'Creador' ? <EvidenceForm key={`${index}-${status}-${evidenceVersion}`} milestone={milestone} busy={busy} submit={submit} />
        : status === 'review' && role === 'Revisor' ? <div className="action-stack">
          <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'review', index, version: evidenceVersion, decision: 'approve' })}>Aprobar evidencia v{evidenceVersion}</button>
          {!milestone.graceUsed && <button className={secondary} type="button" disabled={busy} onClick={() => submit({ kind: 'review', index, version: evidenceVersion, decision: 'requestGrace' })}>Pedir subsanación</button>}
        </div>
        : status === 'objection' && !!progress.walletContribution && !milestone.disputeOpened ? <button className={secondary} type="button" disabled={busy} onClick={() => submit({ kind: 'object', index })}>Objetar el hito</button>
        : status === 'resolving' && role === 'Árbitro' ? <div className="action-stack">
          <button className={primary} type="button" disabled={busy} onClick={() => submit({ kind: 'resolve', index, version: evidenceVersion, decision: 'release' })}>Autorizar el pago</button>
          {!milestone.graceUsed && <button className={secondary} type="button" disabled={busy} onClick={() => submit({ kind: 'resolve', index, version: evidenceVersion, decision: 'requestGrace' })}>Pedir subsanación</button>}
          <button className={secondary} type="button" disabled={busy} onClick={() => submit({ kind: 'resolve', index, version: evidenceVersion, decision: 'cancel' })}>Cancelar y habilitar devoluciones</button>
        </div>
        : status === 'resolving' && !!progress.walletContribution ? <EvidenceForm key={`dispute-${index}-${evidenceVersion}`} milestone={milestone} busy={busy} submit={submit} append />
        : <p>El hito está en curso. El programa habilitará la siguiente acción según el plazo y el rol.</p>}
    </div>
  );
}

function EvidenceForm({ milestone, busy, submit, append = false }: { milestone: Milestone; busy: boolean; submit: (action: Action) => void; append?: boolean }) {
  const [uri, setUri] = useState('');
  const [hash, setHash] = useState('');
  const [error, setError] = useState('');
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const link = evidenceLink(uri);
    if (!link || !/^(?:https?:\/\/|\/(?!\/))/.test(uri) || new TextEncoder().encode(uri).length > 160) {
      setError('Ingresa una URL pública para la evidencia.');
      return;
    }
    if (!/^[a-f\d]{64}$/i.test(hash) || /^0{64}$/.test(hash)) {
      setError('Ingresa un hash SHA-256 de 64 caracteres hexadecimales.');
      return;
    }
    setError('');
    submit({ kind: append ? 'append' : 'submit', index: milestone.index, uri, hash });
  };
  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="evidence-url">URL pública de la evidencia</label>
      <input id="evidence-url" type="text" inputMode="url" value={uri} onChange={(event) => setUri(event.target.value)} maxLength={160} required />
      <label htmlFor="evidence-hash">Hash SHA-256</label>
      <input id="evidence-hash" value={hash} onChange={(event) => setHash(event.target.value)} maxLength={64} minLength={64} spellCheck={false} required />
      {error && <p role="alert">{error}</p>}
      <button className={primary} type="submit" disabled={busy}>{append ? 'Adjuntar evidencia al expediente' : 'Presentar evidencia'}</button>
    </form>
  );
}
