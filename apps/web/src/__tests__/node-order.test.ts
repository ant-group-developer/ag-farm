import { describe, expect, it } from 'vitest';
import {
  NODE_ORDER_PAGE_SIZE,
  canDragSort,
  isOrderView,
  renumber,
  slotsAreLive,
} from '../modules/nodes/node-order';
import type { NodeView } from '../types/api';

function node(id: string, priority_order: number): NodeView {
  return { id, name: id, priority_order, online: true, status: 'active' } as NodeView;
}

describe('node order', () => {
  it('kéo thả chỉ khi xem theo thứ tự tăng dần, không tìm kiếm', () => {
    expect(isOrderView({ sortBy: 'priorityOrder', sortOrder: 'asc', q: '' })).toBe(true);
    expect(isOrderView({ sortBy: 'priorityOrder', sortOrder: 'desc', q: '' })).toBe(false);
    expect(isOrderView({ sortBy: 'name', sortOrder: 'asc', q: '' })).toBe(false);
    expect(isOrderView({ sortBy: 'priorityOrder', sortOrder: 'asc', q: 'scan' })).toBe(false);
  });

  it('kéo thả khi đã tải hết máy và có từ hai máy', () => {
    expect(canDragSort(true, 3, 3)).toBe(true);
    expect(canDragSort(true, NODE_ORDER_PAGE_SIZE, NODE_ORDER_PAGE_SIZE + 1)).toBe(false);
    expect(canDragSort(true, 1, 1)).toBe(false);
    expect(canDragSort(false, 3, 3)).toBe(false);
  });

  it('đánh số lại 1..n theo thứ tự mới', () => {
    const rows = renumber([node('c', 3), node('a', 1), node('b', 2)]);
    expect(rows.map((r) => [r.id, r.priority_order])).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ]);
  });

  it('slot trống chỉ có nghĩa khi máy online và đang bật', () => {
    expect(slotsAreLive({ online: true, status: 'active' })).toBe(true);
    expect(slotsAreLive({ online: false, status: 'active' })).toBe(false);
    expect(slotsAreLive({ online: true, status: 'disabled' })).toBe(false);
  });
});
