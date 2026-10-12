import type { NodeView, ReleaseManifest } from '../../types/api';

/** Worker release packages, as in the hub's latest.json. */
export const RENDER_PACKAGE = 'ag-render-worker';
export const SCAN_PACKAGE = 'ag-scan-worker';

/**
 * Package a node runs: installer names nodes `<machine>-scan` / `<machine>-render`; otherwise guess from the job kinds
 * it reports (studio.* = render, scan.* = scan). Null when neither tells.
 */
export function nodePackage(node: Pick<NodeView, 'name' | 'kinds'>): string | null {
  if (/-render$/i.test(node.name)) return RENDER_PACKAGE;
  if (/-scan$/i.test(node.name)) return SCAN_PACKAGE;
  if (node.kinds.some((k) => k.startsWith('studio.'))) return RENDER_PACKAGE;
  if (node.kinds.some((k) => k.startsWith('scan.'))) return SCAN_PACKAGE;
  return null;
}

function parseVersion(v: string): { nums: number[]; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver order (same rules as @ag-farm/protocol `compareVersions`): negative if `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.nums[i]! - pb.nums[i]!;
    if (d !== 0) return d;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (nx !== null) return -1;
    else if (ny !== null) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Newest published version of the node's package, or null when the farm has none (or the package is unknown). */
export function latestFor(node: Pick<NodeView, 'name' | 'kinds'>, latest: ReleaseManifest | undefined): string | null {
  const pkg = nodePackage(node);
  return (pkg && latest?.packages[pkg]?.version) || null;
}

/** The node runs an older version than the newest release of its package. */
export function isOutdated(node: Pick<NodeView, 'name' | 'kinds' | 'agent_version'>, latest: ReleaseManifest | undefined): boolean {
  const newest = latestFor(node, latest);
  if (!newest || !node.agent_version) return false;
  return compareVersions(node.agent_version, newest) < 0;
}

/** What a render node lacks for some job kinds, read from its capabilities. */
export type MissingTool = 'python' | 'cuda' | 'ytdlp' | 'nvenc';

/**
 * Render nodes only (scan nodes need none of these):
 * - python: no Python that imports torch (no studio.tts / studio.transcribe);
 * - cuda: no NVIDIA GPU with CUDA seen (nvidia-smi / ffmpeg's cuda hwaccel);
 * - ytdlp: no yt-dlp (reference videos);
 * - nvenc: no NVENC encoder (renders on the CPU, slower).
 * Empty when the node never sent capabilities.
 */
export function missingTools(node: Pick<NodeView, 'name' | 'kinds' | 'capabilities'>): MissingTool[] {
  const caps = node.capabilities;
  if (!caps || nodePackage(node) !== RENDER_PACKAGE) return [];
  const out: MissingTool[] = [];
  if (!caps.engines.python) out.push('python');
  if (!caps.gpus.some((g) => g.nvdec)) out.push('cuda');
  if (!caps.engines.ytdlp) out.push('ytdlp');
  if (!caps.gpus.some((g) => g.nvenc)) out.push('nvenc');
  return out;
}

/** The update state worth showing next to the version: anything but a plain idle. */
export function visibleUpdate(node: Pick<NodeView, 'update'>): NodeView['update'] {
  const u = node.update;
  if (!u) return null;
  if (u.state === 'idle' && !u.message) return null;
  return u;
}
