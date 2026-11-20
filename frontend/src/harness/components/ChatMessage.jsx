import React from 'react';
import AreaControls from '../../aoi/AreaControls';
import Markdown from './Markdown';
import RunTimeline from './RunTimeline';
import ResultCards from './ResultCards';

export default function ChatMessage({ message, reconnecting, onFocusLayer }) {
  const user = message.role === 'user';
  return <article className={`agent-message harness-message harness-message--${message.role}`} aria-label={user ? 'Your message' : 'Assistant response'}>
    {user ? <div className="agent-user-bubble">{message.text}
      {message.hasScope ? <small className="agent-message-scope">{message.analysisRegion ? `${message.analysisAoi?.label || 'Drawn analysis area'} · snapshot` : 'Map view · snapshot'}</small> : null}
      {message.analysisRegion ? <AreaControls historyOnly current={{ geojson: message.analysisRegion, source: 'draw', label: message.analysisAoi?.label || 'Historical analysis area' }} scopeKey={`history:${message.id}`} /> : null}
    </div> : <>
      <RunTimeline rows={message.timeline} run={message.run} pending={message.pending} reconnecting={reconnecting}
        assistantLabel={<>
          <img className="agent-assistant-avatar" src="/assets/images/satgpt-avatar.png" width="22" height="22" alt="" aria-hidden="true" />
          <span>SatGPT</span>
        </>} />
      {message.replyParts?.map(part => <div key={part.id} className="agent-reply-part" data-event-id={part.id}>
        <Markdown text={part.text} streaming={part.streaming} />
      </div>)}
      {message.text ? <Markdown text={message.text} streaming={message.streaming} /> : null}
      <ResultCards message={message} onFocusLayer={onFocusLayer} />
    </>}
  </article>;
}
