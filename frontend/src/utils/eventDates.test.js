import { getEventDateError } from './eventDates';

const dates = { pre_date: '2021-07-10', peek_date: '2021-07-20', after_date: '2021-07-30' };

test.each([
  { pre_date: '' },
  { peek_date: '2021-02-29' },
  { after_date: '2021-7-30' },
  { pre_date: '2021-08-01' },
  { after_date: '2021-07-01' },
])('blocks missing, invalid, or out-of-order event dates: %j', (changes) => {
  expect(getEventDateError({ ...dates, ...changes })).toBeTruthy();
});

test('accepts ordered windows, equal dates, and actual leap days', () => {
  expect(getEventDateError(dates)).toBeNull();
  expect(getEventDateError({ pre_date: '2024-02-29', peek_date: '2024-02-29', after_date: '2024-03-01' })).toBeNull();
});
