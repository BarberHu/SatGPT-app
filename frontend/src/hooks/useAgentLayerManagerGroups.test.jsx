import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import useAgentLayerManagerGroups, {
  DEFAULT_HOTSPOT_YEAR_RANGE,
  resolveCatalogLayerDateWindow,
} from './useAgentLayerManagerGroups';

function HookHarness({ options, expose }) {
  expose.current = useAgentLayerManagerGroups(options);
  return null;
}

const createOptions = () => ({
  activeAnalysisAoi: { id: 'aoi-1', label: 'Test AOI' },
  agentImagery: { flood_detection: { tile_url: 'https://tiles.test/{z}/{x}/{y}' } },
  agentLayerLoading: {},
  agentLayerProgress: {},
  agentRasterLayerVisibility: {},
  agentRecommendedLayerData: {},
  agentRecommendedLayerVisibility: {},
  agentShowFloodDetection: true,
  analysisDisplayEnabled: true,
  buildAgentRasterRequestParams: () => ({
    time_start: '2024-01-01',
    time_end: '2024-01-03',
    year_start: DEFAULT_HOTSPOT_YEAR_RANGE[0],
    year_end: DEFAULT_HOTSPOT_YEAR_RANGE[1],
  }),
  catalogRenderAoi: { id: 'aoi-1', label: 'Test AOI' },
  controlPanelCatalogLayers: [],
  currentAfterDate: '2024-01-03',
  currentPeekDate: '2024-01-02',
  currentPreDate: '2024-01-01',
  fetchAgentRasterLayer: vi.fn(),
  getCatalogLayerDateWindow: vi.fn(),
  getRecommendedLayerContextKey: vi.fn(),
  handleAgentRasterDownload: vi.fn(),
  hotspotYearRange: DEFAULT_HOTSPOT_YEAR_RANGE,
  layerData: {},
  rasterDownloadState: {},
  removeMapLayerFromMap: vi.fn(),
  selectedAoiSignature: 'aoi-1',
  setAgentRasterLayerVisibility: vi.fn(),
  setAgentRecommendedLayerVisibility: vi.fn(),
  setAgentShowFloodDetection: vi.fn(),
  setCatalogLayerTimeOverrides: vi.fn(),
  setHotspotYearRange: vi.fn(),
  setSingleInundationTimeWindow: vi.fn(),
  setWarning: vi.fn(),
  singleInundationTimeWindow: {},
});

describe('useAgentLayerManagerGroups', () => {
  let container;
  let root;
  let expose;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    expose = { current: null };
  });

  afterEach(() => {
    act(() => root.unmount());
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('builds the flood detection item for a resolved analysis', () => {
    act(() => root.render(<HookHarness options={createOptions()} expose={expose} />));

    expect(expose.current).toHaveLength(1);
    expect(expose.current[0].key).toBe('overlays');
    expect(expose.current[0].items[0]).toMatchObject({
      id: 'core-flood-detection',
      title: 'Flood Detection',
      checked: true,
      disabled: false,
    });
  });

  test('keeps explicit monthly catalog selection deterministic', () => {
    const window = resolveCatalogLayerDateWindow({
      temporal_type: 'monthly',
      execution_profile: { requires_date_range: true },
    }, {
      year: 2020,
      month: 7,
    }, {
      currentPreDate: '2024-01-01',
      currentPeekDate: '2024-01-02',
      currentAfterDate: '2024-01-03',
    });

    expect(window).toMatchObject({
      mode: 'month',
      year: 2020,
      month: 7,
      start_date: '2020-07-01',
      end_date: '2020-08-01',
    });
  });

  test('treats calendar-month climatology as month-only selection', () => {
    const window = resolveCatalogLayerDateWindow({
      temporal_type: 'monthly',
      execution_profile: {
        requires_date_range: true,
        time_selection: {
          mode: 'calendar_month_property',
          start_year: 1984,
          end_year: 2021,
        },
      },
    }, {
      year: 2020,
      month: 8,
    }, {
      currentPeekDate: '2024-01-02',
    });

    expect(window).toEqual({
      mode: 'calendar_month',
      month: 8,
      start_date: '2000-08-01',
      end_date: '2000-09-01',
      valueLabel: 'Aug recurrence (1984\u20132021)',
    });
  });

  test('does not expose a year field for calendar-month climatology', () => {
    const layer = {
      id: 'monthly-recurrence',
      asset_id: 'JRC/GSW1_4/MonthlyRecurrence',
      title: 'JRC Monthly Water Recurrence',
      temporal_type: 'monthly',
      execution_profile: {
        requires_date_range: true,
        time_selection: {
          mode: 'calendar_month_property',
          start_year: 1984,
          end_year: 2021,
        },
      },
      render_profile: { bands: ['monthly_recurrence'] },
    };
    const options = createOptions();
    options.controlPanelCatalogLayers = [layer];
    options.agentRecommendedLayerVisibility = { [layer.id]: true };
    options.getCatalogLayerDateWindow = () => resolveCatalogLayerDateWindow(
      layer,
      { month: 8 },
      { currentPeekDate: '2024-08-15' }
    );
    options.getRecommendedLayerContextKey = () => 'context:monthly-recurrence:8';

    act(() => root.render(<HookHarness options={options} expose={expose} />));

    const item = expose.current[0].items.find((entry) => entry.title === layer.title);
    expect(item.sliderControl.valueLabel).toBe('Aug recurrence (1984\u20132021)');
    expect(item.sliderControl.fields).toEqual([]);
  });
});
