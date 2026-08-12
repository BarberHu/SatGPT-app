import React, { Profiler, useEffect, useMemo, useRef, useState } from 'react';
import { useCopilotChatInternal } from '@copilotkit/react-core';
import { Paperclip, SendHorizontal, Square } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import {
  appendMentionContext,
  buildMentionCandidates,
  dedupeMentions,
  filterMentionCandidates,
  getMentionQuery,
  reconcileMentionRanges,
} from '../utils/mentionUtils';
import {
  createReactProfilerHandler,
  logAgentDiagnostic,
  useRenderDiagnostics,
} from '../utils/agentDiagnostics';
import './AgentChatInput.css';

function renderHighlightedText(text, mentions) {
  if (!text) {
    return null;
  }

  const sortedMentions = [...mentions].sort((left, right) => left.start - right.start);
  const segments = [];
  let cursor = 0;

  sortedMentions.forEach((mention, index) => {
    const mentionToken = `@${mention.label}`;
    if (
      mention.start < cursor
      || mention.end > text.length
      || text.slice(mention.start, mention.end) !== mentionToken
    ) {
      return;
    }

    if (cursor < mention.start) {
      segments.push(
        <span key={`text-${cursor}`}>{text.slice(cursor, mention.start)}</span>
      );
    }

    segments.push(
      <span
        key={`mention-${mention.id}-${index}`}
        className="agent-mention-token"
      >
        {mentionToken}
      </span>
    );

    cursor = mention.end;
  });

  if (cursor < text.length) {
    segments.push(<span key={`tail-${cursor}`}>{text.slice(cursor)}</span>);
  }

  return segments;
}

function AgentChatInput({
  inProgress,
  onSend,
  onStop,
  onOpenSpatialUpload = null,
  hideStopButton = false,
  chatReady = false,
}) {
  const textareaRef = useRef(null);
  const mirrorRef = useRef(null);
  const rootRef = useRef(null);
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState([]);
  const [activeMentionQuery, setActiveMentionQuery] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const [sendError, setSendError] = useState('');

  const { interrupt } = useCopilotChatInternal();
  const { businessLayers, agentSessionId, agentModule } = useAppContext();
  const placeholderText = {
    wildfire: 'Ask about wildfire readiness or a fire event. Use @ only when selecting a spatial scope.',
    landslide: 'Ask about landslide readiness or a slope-related event. Use @ only when selecting a spatial scope.',
    context: 'Ask about common context layers. Use @ when selecting a spatial scope.',
    imagery: 'Ask about optical or SAR imagery. Use @ when selecting a spatial scope.',
    vector: 'Ask about AOI or vector layers. Use @ when selecting a spatial scope.',
    flood: 'Ask about a flood event. Use @ only when selecting a spatial scope.',
  }[agentModule] || 'Ask about a flood event. Use @ only when selecting a spatial scope.';

  const mentionCandidates = useMemo(
    () => buildMentionCandidates({
      businessLayers,
      agentSessionId,
    }),
    [agentSessionId, businessLayers]
  );

  const filteredCandidates = useMemo(
    () => filterMentionCandidates(mentionCandidates, activeMentionQuery?.query || ''),
    [activeMentionQuery, mentionCandidates]
  );
  const inputProfiler = useMemo(
    () => createReactProfilerHandler('AgentChatInput', () => ({
      textLength: text.length,
      mentionCount: mentions.length,
      candidateCount: filteredCandidates.length,
      inProgress,
      chatReady,
    })),
    [chatReady, filteredCandidates.length, inProgress, mentions.length, text.length]
  );

  useRenderDiagnostics('AgentChatInput', () => ({
    textLength: text.length,
    mentionCount: mentions.length,
    candidateCount: filteredCandidates.length,
    inProgress,
    chatReady,
  }));

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(() => {
    if (!filteredCandidates.length) {
      setActiveIndex(0);
      return;
    }

    setActiveIndex((current) => Math.min(current, filteredCandidates.length - 1));
  }, [filteredCandidates]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setActiveMentionQuery(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const syncScroll = () => {
    if (!textareaRef.current || !mirrorRef.current) {
      return;
    }

    mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
  };

  const canSend = !inProgress && chatReady && text.trim().length > 0 && !interrupt;
  const canStop = inProgress && !hideStopButton;
  const usePlainTextarea = isComposing;

  const updateMentionQuery = (nextText, cursorPosition) => {
    const nextQuery = getMentionQuery(nextText, cursorPosition);
    if (!nextQuery) {
      setActiveMentionQuery(null);
      return;
    }
    setActiveMentionQuery(nextQuery);
  };

  const handleTextChange = (event) => {
    const nextText = event.target.value;
    const nextSelectionStart = event.target.selectionStart ?? nextText.length;

    setSendError('');
    setMentions((previousMentions) =>
      reconcileMentionRanges(previousMentions, text, nextText)
    );
    setText(nextText);
    updateMentionQuery(nextText, nextSelectionStart);
  };

  const applyCandidate = (candidate) => {
    if (!activeMentionQuery || !textareaRef.current) {
      return;
    }

    const mentionToken = `@${candidate.label}`;
    const before = text.slice(0, activeMentionQuery.start);
    const after = text.slice(activeMentionQuery.end);
    const nextText = `${before}${mentionToken} ${after}`;
    const nextMention = {
      id: candidate.id,
      label: candidate.label,
      type: candidate.type,
      source: candidate.source,
      center: candidate.center || null,
      bounds: candidate.bounds || null,
      store_namespace: candidate.store_namespace || null,
      store_key: candidate.store_key || null,
      start: before.length,
      end: before.length + mentionToken.length,
    };

    const updatedMentions = reconcileMentionRanges(mentions, text, nextText)
      .filter((mention) => !(mention.start < nextMention.end && mention.end > nextMention.start));

    setText(nextText);
    setMentions([...updatedMentions, nextMention].sort((left, right) => left.start - right.start));
    setActiveMentionQuery(null);
    setSendError('');

    const caretPosition = before.length + mentionToken.length + 1;
    window.requestAnimationFrame(() => {
      if (!textareaRef.current) {
        return;
      }
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(caretPosition, caretPosition);
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    });
  };

  const handleSend = async () => {
    if (!canSend) {
      return;
    }

    const validMentions = dedupeMentions(
      mentions.filter((mention) => text.slice(mention.start, mention.end) === `@${mention.label}`)
    ).map(({ id, label, center, bounds, store_namespace, store_key }) => ({
      id,
      label,
      center: center || null,
      bounds: bounds || null,
      store_namespace,
      store_key,
    }));

    const draftText = text;
    const draftMentions = mentions;
    const payload = appendMentionContext(draftText, validMentions);
    logAgentDiagnostic('chat', 'send_message', {
      textLength: draftText.length,
      mentionCount: validMentions.length,
      chatReady,
      inProgress,
    });
    setText('');
    setMentions([]);
    setActiveMentionQuery(null);
    setSendError('');

    window.requestAnimationFrame(() => {
      if (!textareaRef.current) {
        return;
      }
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    });

    try {
      await onSend(payload);
    } catch (error) {
      setText(draftText);
      setMentions(draftMentions);
      setSendError(error?.message || 'Failed to send message.');
    }
  };

  const handleKeyDown = async (event) => {
    const dropdownOpen = Boolean(activeMentionQuery && filteredCandidates.length);

    if (dropdownOpen && event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % filteredCandidates.length);
      return;
    }

    if (dropdownOpen && event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + filteredCandidates.length) % filteredCandidates.length);
      return;
    }

    if (dropdownOpen && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault();
      const candidate = filteredCandidates[activeIndex];
      if (candidate) {
        applyCandidate(candidate);
      }
      return;
    }

    if (dropdownOpen && event.key === 'Escape') {
      event.preventDefault();
      setActiveMentionQuery(null);
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
      event.preventDefault();
      if (canSend) {
        await handleSend();
      }
    }
  };

  return (
    <Profiler id="AgentChatInput" onRender={inputProfiler}>
      <div className="agent-chat-input-shell" ref={rootRef}>
        <div className="agent-chat-input-card" onClick={() => textareaRef.current?.focus()}>
          <div className="agent-chat-editor">
            <div
              ref={mirrorRef}
              className={`agent-chat-mirror ${text ? 'has-text' : ''} ${usePlainTextarea ? 'is-hidden' : ''}`}
              aria-hidden="true"
            >
              {text ? renderHighlightedText(text, mentions) : (
                <span className="agent-chat-placeholder">{placeholderText}</span>
              )}
            </div>
            <textarea
              ref={textareaRef}
              className={`agent-chat-textarea ${usePlainTextarea ? 'is-composing' : ''}`}
              value={text}
              rows={1}
              onChange={handleTextChange}
              onClick={(event) => updateMentionQuery(text, event.target.selectionStart ?? text.length)}
              onSelect={(event) => updateMentionQuery(text, event.target.selectionStart ?? text.length)}
              onKeyDown={handleKeyDown}
              onScroll={syncScroll}
              onCompositionStart={() => {
                setIsComposing(true);
                setActiveMentionQuery(null);
              }}
              onCompositionEnd={(event) => {
                setIsComposing(false);
                updateMentionQuery(event.target.value, event.target.selectionStart ?? event.target.value.length);
              }}
              disabled={!chatReady && !inProgress}
            />
          </div>

          <div className="agent-chat-controls">
            {onOpenSpatialUpload ? (
              <button
                type="button"
                className="agent-chat-attach-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenSpatialUpload();
                }}
                disabled={!chatReady}
                aria-label="Upload spatial scope"
                title="Upload spatial scope"
              >
                <Paperclip size={18} strokeWidth={2.2} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className={`agent-chat-send-btn ${canStop ? 'is-stop' : ''}`}
              onClick={canStop ? onStop : handleSend}
              disabled={!canStop && !canSend}
              aria-label={canStop ? 'Stop generating' : 'Send message'}
              title={canStop ? 'Stop generating' : 'Send message'}
            >
              {canStop ? (
                <Square size={15} fill="currentColor" strokeWidth={2.4} aria-hidden="true" />
              ) : (
                <SendHorizontal size={18} strokeWidth={2.4} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {activeMentionQuery && filteredCandidates.length > 0 && (
          <div className="agent-mention-dropdown">
            {filteredCandidates.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                className={`agent-mention-option ${index === activeIndex ? 'active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyCandidate(candidate);
                }}
              >
                <span className="agent-mention-option-title">@{candidate.label}</span>
                <span className="agent-mention-option-meta">{candidate.type} | {candidate.source}</span>
              </button>
            ))}
          </div>
        )}

        {sendError ? (
          <div className="agent-chat-input-error">{sendError}</div>
        ) : null}
      </div>
    </Profiler>
  );
}

export default AgentChatInput;
