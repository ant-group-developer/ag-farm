import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { NODE_LOG_MAX_TEXT_BYTES, type NodeLogRequest, type NodeLogView } from '@ag-farm/protocol';
import { gunzipSync } from 'node:zlib';
import { DataSource } from 'typeorm';

/** Lần xin log còn chờ quá chừng này mà worker chưa gửi thì thành `failed` (máy tắt, bản worker cũ). */
export const NODE_LOG_WAIT_MS = 24 * 60 * 60_000;
/** Reaper xoá log cũ hơn chừng này ngày. */
export const NODE_LOG_KEEP_DAYS = 14;

type LogRow = {
  id: string;
  node_id: string;
  status: NodeLogView['status'];
  since: Date | null;
  until: Date | null;
  requested_at: Date;
  uploaded_at: Date | null;
  size_bytes: number | null;
  error: string | null;
};

const VIEW_COLUMNS = 'id, node_id, status, since, until, requested_at, uploaded_at, size_bytes, error';

function toView(r: LogRow): NodeLogView {
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id,
    node_id: r.node_id,
    status: r.status,
    since: iso(r.since),
    until: iso(r.until),
    requested_at: new Date(r.requested_at).toISOString(),
    uploaded_at: iso(r.uploaded_at),
    size_bytes: r.size_bytes,
    error: r.error,
  };
}

/** Log của máy worker (`farm_node_logs`): admin xin, worker gửi, admin tải, reaper dọn. */
@Injectable()
export class NodeLogsService {
  constructor(private readonly ds: DataSource) {}

  /** Xin log của node; đã có lần xin còn chờ thì trả lần đó (bấm nhiều lần không thành nhiều lần gửi). */
  async request(nodeId: string, range: { since?: string | null; until?: string | null }): Promise<NodeLogView> {
    const since = range.since ?? null;
    const until = range.until ?? null;
    if (since && until && Date.parse(since) >= Date.parse(until)) throw new BadRequestException('since must be before until');
    const nodes: unknown[] = await this.ds.query(`SELECT 1 FROM farm_nodes WHERE id = $1`, [nodeId]);
    if (nodes.length === 0) throw new NotFoundException('Node not found');
    await this.expire(nodeId);
    const open: LogRow[] = await this.ds.query(
      `SELECT ${VIEW_COLUMNS} FROM farm_node_logs WHERE node_id = $1 AND status = 'requested' ORDER BY requested_at LIMIT 1`,
      [nodeId],
    );
    if (open[0]) return toView(open[0]);
    const rows: LogRow[] = await this.ds.query(
      `INSERT INTO farm_node_logs (node_id, since, until) VALUES ($1, $2, $3) RETURNING ${VIEW_COLUMNS}`,
      [nodeId, since, until],
    );
    return toView(rows[0]!);
  }

  /** Các lần xin log gần nhất của node, mới nhất trước. */
  async list(nodeId: string, limit = 10): Promise<{ items: NodeLogView[] }> {
    await this.expire(nodeId);
    const rows: LogRow[] = await this.ds.query(
      `SELECT ${VIEW_COLUMNS} FROM farm_node_logs WHERE node_id = $1 ORDER BY requested_at DESC LIMIT $2`,
      [nodeId, limit],
    );
    return { items: rows.map(toView) };
  }

  /** Lần xin log cũ nhất còn chờ của node (worker hỏi mỗi phút), hoặc null. */
  async pending(nodeId: string): Promise<NodeLogRequest | null> {
    await this.expire(nodeId);
    const rows: LogRow[] = await this.ds.query(
      `SELECT ${VIEW_COLUMNS} FROM farm_node_logs WHERE node_id = $1 AND status = 'requested' ORDER BY requested_at LIMIT 1`,
      [nodeId],
    );
    const r = rows[0];
    if (!r) return null;
    const v = toView(r);
    return { id: v.id, since: v.since, until: v.until };
  }

  /** Log worker gửi (gzip) cho một lần xin của chính nó; nén hỏng hoặc quá lớn thì từ chối. */
  async store(nodeId: string, id: string, gz: Buffer): Promise<void> {
    const rows: Array<{ status: string }> = await this.ds.query(
      `SELECT status FROM farm_node_logs WHERE id = $1 AND node_id = $2`,
      [id, nodeId],
    );
    if (!rows[0]) throw new NotFoundException('Log request not found');
    if (rows[0].status !== 'requested') throw new ConflictException(`Log request is ${rows[0].status}`);
    let size: number;
    try {
      size = gunzipSync(gz, { maxOutputLength: NODE_LOG_MAX_TEXT_BYTES + 1024 * 1024 }).length;
    } catch (err) {
      throw new BadRequestException(`Body is not a gzip of the logs: ${String(err)}`);
    }
    await this.ds.query(
      `UPDATE farm_node_logs SET status = 'uploaded', content = $3, size_bytes = $4, uploaded_at = now(), error = NULL
        WHERE id = $1 AND node_id = $2 AND status = 'requested'`,
      [id, nodeId, gz, size],
    );
  }

  /** Log đã gửi, giải nén, kèm tên file để tải về. */
  async file(nodeId: string, id: string): Promise<{ filename: string; text: Buffer }> {
    const rows: Array<{ name: string; requested_at: Date; content: Buffer | null; status: string }> = await this.ds.query(
      `SELECT n.name, l.requested_at, l.content, l.status
         FROM farm_node_logs l JOIN farm_nodes n ON n.id = l.node_id
        WHERE l.id = $1 AND l.node_id = $2`,
      [id, nodeId],
    );
    const r = rows[0];
    if (!r) throw new NotFoundException('Log not found');
    if (r.status !== 'uploaded' || !r.content) throw new ConflictException(`Log is ${r.status}`);
    const stamp = new Date(r.requested_at).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const safeName = r.name.replace(/[^\w.-]+/g, '_');
    return { filename: `${safeName}-${stamp}.log`, text: gunzipSync(r.content) };
  }

  /** Xoá log cũ hơn `before`; trả số dòng đã xoá. */
  async prune(before: Date): Promise<number> {
    const res: [unknown[], number] = await this.ds.query(`DELETE FROM farm_node_logs WHERE requested_at < $1`, [before]);
    return Array.isArray(res) ? (res[1] ?? 0) : 0;
  }

  /** Lần xin chờ quá `NODE_LOG_WAIT_MS` thành `failed`. */
  private async expire(nodeId: string): Promise<void> {
    await this.ds.query(
      `UPDATE farm_node_logs SET status = 'failed', error = 'The worker did not send its logs within 24 hours (machine off, or a worker too old for this)'
        WHERE node_id = $1 AND status = 'requested' AND requested_at < $2`,
      [nodeId, new Date(Date.now() - NODE_LOG_WAIT_MS)],
    );
  }
}
