export const MENTION_CONTEXT_START = '<<SATGPT_MENTION_CONTEXT>>';
export const MENTION_CONTEXT_END = '<<END_SATGPT_MENTION_CONTEXT>>';

const MENTION_BLOCK_PATTERN = new RegExp(
  `${MENTION_CONTEXT_START}[\\s\\S]*?${MENTION_CONTEXT_END}`,
  'g'
);

export function stripMentionContext(text = '') {
  return String(text)
    .replace(MENTION_BLOCK_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function extractTextFromMessageContent(content) {
  if (typeof content === 'undefined' || content === null) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part?.type === 'text') {
          return part.text || '';
        }
        return '';
      })
      .join(' ')
      .trim();
  }

  return '';
}

export function extractVisibleMessageText(content) {
  return stripMentionContext(extractTextFromMessageContent(content));
}

export function appendMentionContext(text = '', mentions = []) {
  const visibleText = stripMentionContext(text);
  if (!mentions.length) {
    return visibleText;
  }

  const payload = JSON.stringify({ mentions });
  return `${visibleText}\n\n${MENTION_CONTEXT_START}\n${payload}\n${MENTION_CONTEXT_END}`;
}

function makeCandidate({
  id,
  label,
  type,
  source,
  center = null,
  bounds = null,
  description,
  store_namespace = null,
  store_key = null,
  searchText = '',
}) {
  return {
    id,
    label,
    type,
    source,
    center,
    bounds,
    description,
    store_namespace,
    store_key,
    searchText: `${label} ${id} ${type} ${source} ${description || ''} ${searchText}`.toLowerCase(),
  };
}

export function buildMentionCandidates({
  businessLayers = [],
  agentSessionId = null,
}) {
  const candidates = [];
  const seen = new Set();

  businessLayers.forEach((layer) => {
    if (!layer?.id || seen.has(layer.id)) {
      return;
    }

    seen.add(layer.id);
    candidates.push(
      makeCandidate({
        id: layer.id,
        label: layer.label || layer.id,
        type: layer.kind || 'uploaded_aoi',
        source: layer.source || layer.origin || 'upload',
        center: layer.center || null,
        bounds: layer.bounds || null,
        description: layer.is_active ? 'Spatial scope (active)' : 'Spatial scope',
        store_namespace: 'business_layer_store',
        store_key: agentSessionId,
        searchText: [
          layer.origin,
          layer.geometry_type,
          layer.layer_role,
        ]
          .filter(Boolean)
          .join(' '),
        })
    );
  });

  return candidates;
}

export function getMentionQuery(text = '', cursorPosition = 0) {
  const safeCursor = Number.isFinite(cursorPosition) ? cursorPosition : text.length;
  const before = text.slice(0, safeCursor);
  const atIndex = before.lastIndexOf('@');

  if (atIndex < 0) {
    return null;
  }

  const leadingChar = atIndex > 0 ? before[atIndex - 1] : '';
  if (leadingChar && /[\w\u4e00-\u9fa5]/.test(leadingChar)) {
    return null;
  }

  const fragment = before.slice(atIndex + 1);
  if (/\s/.test(fragment)) {
    return null;
  }

  return {
    start: atIndex,
    end: safeCursor,
    query: fragment.toLowerCase(),
  };
}

export function filterMentionCandidates(candidates = [], query = '') {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  return candidates.filter((candidate) => {
    if (!normalizedQuery) {
      return true;
    }
    return candidate.searchText.includes(normalizedQuery);
  });
}

export function reconcileMentionRanges(previousMentions = [], previousText = '', nextText = '') {
  if (!previousMentions.length) {
    return [];
  }

  let start = 0;
  while (
    start < previousText.length &&
    start < nextText.length &&
    previousText[start] === nextText[start]
  ) {
    start += 1;
  }

  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  const delta = nextText.length - previousText.length;

  return previousMentions
    .map((mention) => {
      const expectedToken = `@${mention.label}`;

      if (mention.end <= start) {
        return nextText.slice(mention.start, mention.end) === expectedToken ? mention : null;
      }

      if (mention.start >= previousEnd) {
        const shifted = {
          ...mention,
          start: mention.start + delta,
          end: mention.end + delta,
        };
        return nextText.slice(shifted.start, shifted.end) === expectedToken ? shifted : null;
      }

      return null;
    })
    .filter(Boolean);
}

export function dedupeMentions(mentions = []) {
  const seen = new Set();
  return mentions.filter((mention) => {
    const key = `${mention.store_key || 'global'}::${mention.id}`;
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
