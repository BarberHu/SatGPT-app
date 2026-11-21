import React, { useEffect, useRef, useState } from 'react';
import { chatApi } from '../chatApi';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog';

const requestMessages = {
  pending: 'Waiting for the deployer to approve this request.',
  expired: 'The request expired. Create a new request to continue.',
};

function SelectableValue({ label, value }) {
  return <label className="agent-recovery-value">
    {label}
    <input value={value} readOnly onFocus={event => event.target.select()} />
  </label>;
}

function RecoveryForm({ currentId, onRecovered }) {
  const [request, setRequest] = useState(null);
  const [requestCode, setRequestCode] = useState(null);
  const [proof, setProof] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const action = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    chatApi.recoveryStatus(abort.signal).then(value => {
      if (!abort.signal.aborted) setRequest(value);
    }).catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, []);

  const run = async operation => {
    if (action.current) return;
    action.current = true;
    setError('');
    setBusy(true);
    try { await operation(); }
    catch (cause) { setError(cause.message); }
    finally { action.current = false; setBusy(false); }
  };
  const create = () => run(async () => {
    const { code, ...status } = await chatApi.createRecoveryRequest();
    setRequestCode({ id: status.request_id, code });
    setRequest(status);
  });
  const check = () => run(async () => setRequest(await chatApi.recoveryStatus()));
  const claim = () => run(async () => {
    const { count } = await chatApi.claimRecovery(request.request_id);
    setRequest({ ...request, status: 'consumed', count });
    setRequestCode(null);
    await onRecovered();
  });
  const status = request?.status;
  const code = requestCode?.id === request?.request_id && requestCode?.code;
  return <>
    <section>
      <h3>Recover on this browser</h3>
      <p>Give the request code and your saved recovery credential to the deployer through your support channel.</p>
      {code && status !== 'consumed' && status !== 'expired' ? <SelectableValue label="Request code" value={code} /> : null}
      <p role="status">
        {status === 'approved' ? `Approved to recover ${request.count} conversation(s).` : null}
        {status === 'consumed' ? `${request.count} conversation(s) restored. Check your history.` : null}
        {requestMessages[status]}
      </p>
      <div className="agent-recovery-actions">
        {status === 'approved'
          ? <Button type="button" size="sm" disabled={busy} onClick={claim}>Recover approved conversations</Button>
          : <Button type="button" size="sm" disabled={busy || (!request && !error)} onClick={create}>
            {status === 'pending' ? 'Replace request code' : 'Create request code'}
          </Button>}
        <Button type="button" size="sm" variant="outline" disabled={busy || (!request && !error)}
          onClick={status === 'consumed' ? () => run(onRecovered) : check}>
          {status === 'consumed' ? 'Refresh history' : 'Check approval'}
        </Button>
        {status === 'approved' && error ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={create}>
          Replace request code
        </Button> : null}
      </div>
    </section>
    {currentId ? <section>
      <h3>Save a credential for this conversation</h3>
      <p>Save the ID and credential somewhere private before switching browsers. Generating a credential replaces the previous one.</p>
      {proof ? <>
        <SelectableValue label="Conversation ID" value={currentId} />
        <SelectableValue label="Recovery credential" value={proof} />
      </> : null}
      <Button type="button" size="sm" variant="outline" disabled={busy}
        onClick={() => run(async () => setProof((await chatApi.issueRecoveryProof(currentId)).code))}>
        Generate recovery credential
      </Button>
    </section> : null}
    {error ? <p className="agent-recovery-error" role="alert">{error}</p> : null}
  </>;
}

export default function ConversationRecovery({ currentId, onRecovered }) {
  return <Dialog>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="agent-recovery-trigger">Conversation recovery</Button>
    </DialogTrigger>
    <DialogContent className="agent-recovery-dialog">
      <DialogTitle>Conversation recovery</DialogTitle>
      <DialogDescription>Move selected Agent conversations to this browser with help from your deployer.</DialogDescription>
      <RecoveryForm currentId={currentId} onRecovered={onRecovered} />
    </DialogContent>
  </Dialog>;
}
