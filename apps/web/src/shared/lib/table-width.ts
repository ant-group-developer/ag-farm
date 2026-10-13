/** Width of the selection checkbox column antd adds for `rowSelection`. */
export const SELECTION_COLUMN_WIDTH = 48;

/**
 * Sum of the column widths, for `scroll.x`: with every column given a width, the table scrolls at
 * exactly that size instead of squeezing columns (and wrapping their headers) on narrow screens.
 * Takes antd `ColumnsType` and pro-components `ProColumns` alike.
 */
export function columnsWidth(columns: readonly { width?: number | string }[], extra = 0): number {
  return columns.reduce((sum, c) => sum + Number(c.width ?? 0), extra);
}
