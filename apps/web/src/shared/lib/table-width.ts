import type { ColumnsType } from 'antd/es/table';

/** Width of the selection checkbox column antd adds for `rowSelection`. */
export const SELECTION_COLUMN_WIDTH = 48;

/**
 * Sum of the column widths, for `scroll.x`: with every column given a width, the table scrolls at
 * exactly that size instead of squeezing columns (and wrapping their headers) on narrow screens.
 */
export function columnsWidth<T>(columns: ColumnsType<T>, extra = 0): number {
  return columns.reduce((sum, c) => sum + Number(c.width ?? 0), extra);
}
