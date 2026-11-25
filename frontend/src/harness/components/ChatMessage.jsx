import React from 'react';
import AreaControls from '../../aoi/AreaControls';
import { publicPath } from '../../utils/publicPath.js';
import Markdown from './Markdown';
import RunTimeline from './RunTimeline';
import ResultCards from './ResultCards';

function TurnUsage({ usage }) {
  const { status, input_tokens, output_tokens, total_tokens, estimated_cost: cost } = usage;
  const format = new Intl.NumberFormat('en-US');
  const estimatedCost = cost?.currency === 'USD' && Number.isFinite(Number(cost.amount)) && Number(cost.amount) > 0
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 }).format(cost.amount)
    : null;
  return <div className="agent-turn-usage" aria-label="Turn usage">
    <span>{status === 'unavailable' || !total_tokens ? 'Token usage unavailable' :
      `${format.format(total_tokens)} tokens (${format.format(input_tokens)} input, ${format.format(output_tokens)} output)`}</span>
    {status === 'partial' ? <span>Partial usage</span> : null}
    <span>{estimatedCost ? `Estimated cost ${estimatedCost} (${cost.reference_route} list rates)` : 'Estimated cost unavailable'}</span>
  </div>;
}

export default function ChatMessage({ message, reconnecting, onFocusLayer }) {
  const user = message.role === 'user';
  return <article className={`agent-message harness-message harness-message--${message.role}`} aria-label={user ? 'Your message' : 'Assistant response'}>
    {user ? <div className="agent-user-bubble">{message.text}
      {message.hasScope ? <small className="agent-message-scope">{message.analysisRegion ? `${message.analysisAoi?.label || 'Drawn analysis area'} · snapshot` : 'Map view · snapshot'}</small> : null}
      {message.analysisRegion ? <AreaControls historyOnly current={{ geojson: message.analysisRegion, source: 'draw', label: message.analysisAoi?.label || 'Historical analysis area' }} scopeKey={`history:${message.id}`} /> : null}
    </div> : <>
      <RunTimeline rows={message.timeline} run={message.run} pending={message.pending} reconnecting={reconnecting}
        assistantLabel={<>
          <img className="agent-assistant-avatar" src={publicPath('/assets/images/satgpt-avatar.png')} width="22" height="22" alt="" aria-hidden="true" />
          <span>SatGPT</span>
        </>} />
      {message.replyParts?.map(part => <div key={part.id} className="agent-reply-part" data-event-id={part.id}>
        <Markdown text={part.text} streaming={part.streaming} />
      </div>)}
      {message.text ? <Markdown text={message.text} streaming={message.streaming} /> : null}
      <ResultCards message={message} onFocusLayer={onFocusLayer} />
      {import.meta.env.DEV && !message.pending && message.usage ? <TurnUsage usage={message.usage} /> : null}
    </>}
  </article>;
}
