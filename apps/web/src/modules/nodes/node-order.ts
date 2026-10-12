import type { NodeSortBy, NodeView, SortOrder } from '../../types/api';

/** API trả tối đa 200 dòng một trang: ở chế độ xếp thứ tự, tải cả danh sách trong một trang để kéo thả. */
export const NODE_ORDER_PAGE_SIZE = 200;

/**
 * Đang xem theo thứ tự nhận việc (số nhỏ trước, không lọc): chỉ khi đó cả danh sách hiện đúng thứ tự,
 * nên mới kéo thả được.
 */
export function isOrderView(query: { sortBy: NodeSortBy; sortOrder: SortOrder; q?: string | null }): boolean {
  return query.sortBy === 'priorityOrder' && query.sortOrder === 'asc' && !query.q;
}

/** Kéo thả được khi đang xem theo thứ tự và đã tải hết máy (thứ tự gửi lên là thứ tự của cả farm). */
export function canDragSort(orderView: boolean, loaded: number, total: number): boolean {
  return orderView && loaded >= total && total > 1;
}

/** Đánh lại số 1..n theo thứ tự mới (hiển thị ngay, trước khi hub trả về). */
export function renumber(rows: readonly NodeView[]): NodeView[] {
  return rows.map((r, i) => (r.priority_order === i + 1 ? r : { ...r, priority_order: i + 1 }));
}

/**
 * Slot trống có còn đúng không: hub chỉ biết slot trống ở lần heartbeat gần nhất, máy offline hay tắt
 * thì số đó không còn nghĩa là nó đang nhận việc.
 */
export function slotsAreLive(node: Pick<NodeView, 'online' | 'status'>): boolean {
  return node.online && node.status === 'active';
}
