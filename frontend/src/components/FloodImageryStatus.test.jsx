import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import FloodImageryStatus from './FloodImageryStatus';

const fixture = vi.hoisted(() => ({ context: {} }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => fixture.context }));

test('distinguishes confirmation, satellite loading, visible results, and errors', () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (overrides) => {
    fixture.context = { agentAnalysisContext: { user_confirmed: true }, ...overrides };
    act(() => root.render(<FloodImageryStatus />));
    return container.textContent;
  };
  try {
    expect(render({ agentAnalysisContext: { user_confirmed: false } })).toBe('');
    expect(render({})).toContain('Satellite analysis is pending');
    expect(render({ agentFloodImageryLoading: true })).toContain('The text report may finish first');
    expect(render({ agentShowFloodDetection: true,
      agentImagery: { flood_detection: { tile_url: 'tile' } } })).toContain('Red pixels mark suspected inundation');
    expect(render({ agentImagery: { flood_detection: { tile_url: 'tile' } } })).toContain('Open FLOOD');
    expect(render({ agentImagery: { flood_detection: { error: 'No SAR observations in window' } } }))
      .toContain('unavailable: No SAR observations in window');
  } finally {
    act(() => root.unmount());
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
