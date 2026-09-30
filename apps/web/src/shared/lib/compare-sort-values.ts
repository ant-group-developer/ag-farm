/** A value rows are sorted by: text, a number (timestamps as epoch ms) or missing. */
export type SortValue = string | number | null | undefined;

export type SortDirection = 'asc' | 'desc';

const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });

function isMissing(value: SortValue): value is null | undefined {
  return value === null || value === undefined || value === '' || Number.isNaN(value as number);
}

/** Epoch milliseconds of a timestamp, or `null` when missing or invalid. */
export function toTimestamp(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Ascending order: natural, case- and accent-insensitive text,
 * numeric numbers; missing values last.
 */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (isMissing(a) || isMissing(b)) {
    return isMissing(a) === isMissing(b) ? 0 : isMissing(a) ? 1 : -1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return collator.compare(String(a), String(b));
}

/** Sorted copy of `rows`; missing values stay last in both directions. */
export function sortRows<T>(
  rows: readonly T[],
  getValue: (row: T) => SortValue,
  direction: SortDirection,
): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const valueA = getValue(a);
    const valueB = getValue(b);
    const result = compareSortValues(valueA, valueB);
    return isMissing(valueA) !== isMissing(valueB) ? result : result * sign;
  });
}
