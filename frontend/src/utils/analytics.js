const STORAGE_KEY = 'satgpt_ux_events';

const canUseStorage = () => typeof window !== 'undefined' && window.localStorage;

export const readUxEvents = () => {
  if (!canUseStorage()) {
    return [];
  }

  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
  } catch (error) {
    return [];
  }
};

export const writeUxEvents = (events) => {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
};

export const trackUxEvent = (name, payload = {}) => {
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name,
    payload,
    timestamp: new Date().toISOString(),
  };

  const events = readUxEvents();
  events.push(event);
  writeUxEvents(events);

  if (typeof window !== 'undefined') {
    window.__SATGPT_UX_EVENTS__ = events;
  }

  console.info('[SatGPT UX]', name, payload);
  return event;
};

export const clearUxEvents = () => {
  writeUxEvents([]);
};

export const downloadUxEvents = (filename = 'satgpt-ux-events.json') => {
  const blob = new Blob([JSON.stringify(readUxEvents(), null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
