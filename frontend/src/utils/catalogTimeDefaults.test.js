import {
  resolveDefaultCatalogHistoryRange,
  resolveDefaultCatalogPointSelection,
  resolveDefaultCatalogYearRange,
} from './catalogTimeDefaults';

const yearBounds = { minYear: 1984, maxYear: 2021 };

describe('catalog time-control defaults', () => {
  test('point controls use the event peak consistently', () => {
    expect(resolveDefaultCatalogPointSelection({
      ...yearBounds,
      peakDate: '2019-07-18',
      startDate: '2019-07-01',
      endDate: '2019-07-31',
    })).toEqual({ year: 2019, month: 7 });
  });

  test('point controls fall back to the left dataset endpoint', () => {
    expect(resolveDefaultCatalogPointSelection(yearBounds)).toEqual({
      year: 1984,
      month: 1,
    });
  });

  test('an event newer than the dataset keeps its seasonal month and clamps its year', () => {
    expect(resolveDefaultCatalogPointSelection({
      ...yearBounds,
      peakDate: '2026-08-12',
    })).toEqual({ year: 2021, month: 8 });
  });

  test('year ranges use the event window and otherwise collapse at the left endpoint', () => {
    expect(resolveDefaultCatalogYearRange({
      ...yearBounds,
      startDate: '2018-03-01',
      endDate: '2020-09-30',
    })).toEqual([2018, 2020]);
    expect(resolveDefaultCatalogYearRange(yearBounds)).toEqual([1984, 1984]);
  });

  test('historical statistics start at the left endpoint and retain the full period', () => {
    expect(resolveDefaultCatalogHistoryRange(yearBounds)).toEqual([1984, 2021]);
  });
});
