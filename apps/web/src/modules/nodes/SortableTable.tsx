import { ProTable, type ProTableProps } from '@ant-design/pro-components';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createContext, useContext, useMemo, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

/**
 * Bảng kéo thả thay cho `DragSortTable` của pro-table: bản đó dựng lại component `DndContext` ở mỗi lần render
 * (deps của nó là `dataSource.slice()`), nên mỗi lần tải định kỳ cả bảng bị gỡ ra lắp lại và nháy. Ở đây mọi
 * component (row, DndContext, SortableContext) giữ nguyên kiểu, dữ liệu mới chỉ cập nhật các ô.
 */

type HandleProps = { attributes: DraggableAttributes; listeners: DraggableSyntheticListeners } | null;

const HandleContext = createContext<HandleProps>(null);

/** Tay nắm kéo của dòng chứa nó; không hiện gì khi bảng đang tắt kéo thả. */
export function DragHandle({ children }: { children: ReactNode }) {
  const handle = useContext(HandleContext);
  if (!handle) return null;
  return (
    <span {...handle.attributes} {...handle.listeners} style={{ display: 'inline-flex', touchAction: 'none' }}>
      {children}
    </span>
  );
}

const SortableDisabledContext = createContext(true);

function SortableRow(props: HTMLAttributes<HTMLTableRowElement> & { 'data-row-key'?: string }) {
  const disabled = useContext(SortableDisabledContext);
  const id = props['data-row-key'] ?? '';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style: CSSProperties = {
    ...props.style,
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? { position: 'relative', zIndex: 9 } : {}),
  };
  const handle = useMemo(() => (disabled ? null : { attributes, listeners }), [disabled, attributes, listeners]);
  return (
    <HandleContext.Provider value={handle}>
      <tr {...props} ref={setNodeRef} style={style} />
    </HandleContext.Provider>
  );
}

const COMPONENTS = { body: { row: SortableRow } };

type SortableTableProps<T extends object> = Omit<ProTableProps<T, Record<string, unknown>>, 'rowKey'> & {
  rowKey: keyof T & string;
  dataSource: T[];
  /** Tắt kéo thả (tay nắm ẩn đi). */
  sortDisabled?: boolean;
  /** Thứ tự mới sau khi thả. */
  onSortEnd: (ordered: T[]) => void;
};

export function SortableTable<T extends object>({
  rowKey,
  dataSource,
  sortDisabled = false,
  onSortEnd,
  ...rest
}: SortableTableProps<T>) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = useMemo(() => dataSource.map((r) => String(r[rowKey])), [dataSource, rowKey]);

  // Đọc dữ liệu mới nhất lúc thả mà không đổi handler (DndContext không phải dựng lại).
  const latest = useRef({ dataSource, ids, onSortEnd });
  latest.current = { dataSource, ids, onSortEnd };
  const onDragEnd = useRef((e: DragEndEvent) => {
    const { dataSource: rows, ids: keys, onSortEnd: done } = latest.current;
    if (!e.over || e.active.id === e.over.id) return;
    const from = keys.indexOf(String(e.active.id));
    const to = keys.indexOf(String(e.over.id));
    if (from < 0 || to < 0) return;
    done(arrayMove(rows, from, to));
  }).current;

  return (
    <SortableDisabledContext.Provider value={sortDisabled}>
      <ProTable<T>
        {...rest}
        rowKey={rowKey}
        dataSource={dataSource}
        components={COMPONENTS}
        tableViewRender={(_, dom) => (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={sortDisabled}>
              {dom}
            </SortableContext>
          </DndContext>
        )}
      />
    </SortableDisabledContext.Provider>
  );
}
