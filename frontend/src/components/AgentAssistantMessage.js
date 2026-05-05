import React from 'react';
import { AssistantMessage as DefaultAssistantMessage } from '@copilotkit/react-ui';
import ReactMarkdown from 'react-markdown';

function getMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part?.text || part?.content || '';
      })
      .join('');
  }

  return content == null ? '' : String(content);
}

function parseJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  try {
    const data = JSON.parse(trimmed);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function isIntentPayload(text) {
  const data = parseJsonObject(text);
  return Boolean(
    data
    && Object.prototype.hasOwnProperty.call(data, 'intent_type')
    && Object.prototype.hasOwnProperty.call(data, 'should_start_workflow')
    && Object.prototype.hasOwnProperty.call(data, 'should_use_search')
  );
}

function AgentThinkingMessage() {
  return (
    <div className="copilotKitMessage copilotKitAssistantMessage agent-assistant-thinking" role="status" aria-live="polite">
      <span className="agent-assistant-thinking-spinner" aria-hidden="true" />
      <span>Thinking</span>
    </div>
  );
}

function splitReferenceSources(text) {
  const sectionMatch = String(text || '').match(/(^|\n)##\s+Reference Sources\s*\n/i);

  if (!sectionMatch || sectionMatch.index == null) {
    return null;
  }

  const headingStart = sectionMatch.index + sectionMatch[1].length;
  const body = text.slice(0, headingStart).replace(/\n-{3,}\s*$/m, '').trimEnd();
  const sources = text.slice(headingStart).trim();

  return body && sources ? { body, sources } : null;
}

function countReferenceItems(markdown) {
  const matches = String(markdown || '').match(/^\s*\d+\.\s+/gm);
  return matches?.length || 0;
}

function ReferenceSourcesDisclosure({ markdown }) {
  const sourceCount = countReferenceItems(markdown);
  const countLabel = sourceCount > 0 ? ` (${sourceCount})` : '';

  return (
    <details className="agent-reference-sources">
      <summary className="agent-reference-sources__summary">
        <span>Reference Sources{countLabel}</span>
        <span className="agent-reference-sources__hint">Show</span>
      </summary>
      <div className="agent-reference-sources__content">
        <ReactMarkdown>{markdown}</ReactMarkdown>
      </div>
    </details>
  );
}

function AgentAssistantMessage(props) {
  const text = getMessageText(props.message?.content);
  const referenceSections = splitReferenceSources(text);

  if (isIntentPayload(text)) {
    return props.isCurrentMessage || props.isLoading ? <AgentThinkingMessage /> : null;
  }

  if ((props.isLoading || props.isGenerating) && !text.trim()) {
    return <AgentThinkingMessage />;
  }

  if (referenceSections) {
    const bodyMessage = {
      ...props.message,
      content: referenceSections.body,
    };

    return (
      <>
        <DefaultAssistantMessage {...props} message={bodyMessage} />
        <ReferenceSourcesDisclosure markdown={referenceSections.sources} />
      </>
    );
  }

  return <DefaultAssistantMessage {...props} />;
}

export default AgentAssistantMessage;
