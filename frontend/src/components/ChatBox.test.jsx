import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatBox from './ChatBox';
import Modals from './Modals';
import { sendChatMessage, getHistoricalMap } from '../services/api';
import { buildAoiFromGeoJSON } from '../utils/aoi';

const testState = vi.hoisted(() => ({ context: null, selectedAOI: null }));
const setIsResultVisible = vi.fn();
const setIsLoading = vi.fn();

vi.mock('../context/AppContext', () => ({
  useAppContext: () => testState.context,
}));
vi.mock('../services/api', () => ({
  sendChatMessage: vi.fn(),
  getHistoricalMap: vi.fn(),
  getFloodHotspotMap: vi.fn(),
}));

function Harness() {
  const [chatInput, setChatInput] = useState('Tell me about the 2021 Zhengzhou floods');
  const [activeModal, setActiveModal] = useState(null);
  const [resultText, setResultText] = useState('');
  const [gridClickEnabled, setGridClickEnabled] = useState(false);
  testState.context = {
    chatInput, setChatInput, activeModal, setActiveModal,
    resultText, setResultText, gridClickEnabled, setGridClickEnabled,
    setGptResponse: vi.fn(), setIsLoading, setIsResultVisible, setWarning: vi.fn(),
    updateLayerData: vi.fn(), setGeeCodeUrl: vi.fn(),
    selectedAOI: testState.selectedAOI, dataType: 'historical', countries: {}, mapInstance: null,
  };
  return <><ChatBox /><Modals /></>;
}

describe('Basic question before grid selection', () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    testState.selectedAOI = null;
    sendChatMessage.mockResolvedValue({ message: JSON.stringify({ response: [{
      Content: 'Flood summary', CountryCode: 'CN',
      start_date: '2021-07-01', end_date: '2021-07-31',
    }] }) });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(async () => {
    // Let the suggestion blur timer settle before tearing down jsdom.
    await act(async () => new Promise(resolve => setTimeout(resolve, 250)));
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  test('sends Enter to Ask and then prompts for a grid without requesting a map', async () => {
    const input = container.querySelector('input');
    act(() => input.focus());
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    await act(async () => { input.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(getHistoricalMap).not.toHaveBeenCalled();
    expect(testState.context.resultText).toBe('Flood summary');
    expect(setIsResultVisible).toHaveBeenCalledWith(true);
    expect(testState.context.gridClickEnabled).toBe(true);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement.textContent).toBe('OK');
  });

  test.each([
    { isComposing: true },
    { keyCode: 229 },
  ])('does not submit an Enter used to confirm IME input: %j', (imeState) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, ...imeState,
    });
    act(() => container.querySelector('input').dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  test('mouse submission opens a dismissible grid prompt after the Ask response', async () => {
    await act(async () => { container.querySelector('.send-btn-gemini').click(); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => container.querySelector('.info-modal-btn').click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('shows the answer while the selected AOI map request is still running', async () => {
    testState.selectedAOI = buildAoiFromGeoJSON({
      type: 'Polygon', coordinates: [[[113, 33], [115, 33], [115, 35], [113, 35], [113, 33]]],
    });
    act(() => root.render(<Harness />));
    getHistoricalMap.mockImplementation(() => new Promise(() => {}));

    await act(async () => { container.querySelector('.send-btn-gemini').click(); });

    expect(testState.context.resultText).toBe('Flood summary');
    expect(getHistoricalMap).toHaveBeenCalledTimes(1);
    expect(setIsLoading).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('[role="status"]').textContent).toContain('Loading map layers');
  });
});
