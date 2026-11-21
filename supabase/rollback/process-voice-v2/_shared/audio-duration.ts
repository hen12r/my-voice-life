// Reads the real playing time of a recording from its container, without decoding audio.
// Pure TypeScript (no Deno/browser APIs): used by the process-voice Edge Function before any
// paid call, so allowances and budget holds are based on the audio actually uploaded rather
// than on a length the client claims. Supports what browsers' MediaRecorder produces:
//   - WebM/Matroska (Chrome, Edge, Firefox): MediaRecorder writes no Duration header, so the
//     duration is taken from the last block timestamp (+ one frame).
//   - Ogg (Opus/Vorbis): granule position of the last page.
//   - MP4/M4A (Safari): mvhd/mdhd/stts, and fragmented MP4 (moof/traf/tfdt/trun).
// Returns null when the container is not recognised or cannot be parsed.

export type ContainerKind = 'webm' | 'ogg' | 'mp4';

export function sniffContainer(b: Uint8Array): ContainerKind | null {
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg';
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4'; // 'ftyp'
  return null;
}

/** Duration in seconds, or null if it cannot be determined from the container. */
export function parseAudioDuration(bytes: Uint8Array): number | null {
  try {
    const kind = sniffContainer(bytes);
    const d = kind === 'webm' ? webmDuration(bytes) : kind === 'ogg' ? oggDuration(bytes) : kind === 'mp4' ? mp4Duration(bytes) : null;
    return d !== null && Number.isFinite(d) && d > 0 ? Math.round(d * 1000) / 1000 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- WebM / Matroska (EBML)
const ID = {
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
};
// Master elements we descend into in-line (children are read sequentially), which makes
// "unknown size" elements written by live recorders harmless.
const ENTER = new Set([ID.Segment, ID.Info, ID.Cluster, ID.BlockGroup]);

function readVint(b: Uint8Array, pos: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(b: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[pos + i];
  return v;
}

function readFloat(b: Uint8Array, pos: number, len: number): number {
  const dv = new DataView(b.buffer, b.byteOffset + pos, len);
  return len === 4 ? dv.getFloat32(0) : len === 8 ? dv.getFloat64(0) : NaN;
}

function webmDuration(b: Uint8Array): number | null {
  let pos = 0;
  let scaleNs = 1_000_000;
  let headerDuration = 0;
  let clusterTc = 0;
  let maxTs = -1;
  let prevTs = -1;
  let lastDelta = 0;
  while (pos < b.length) {
    const id = readVint(b, pos, true);
    if (!id) break;
    const size = readVint(b, pos + id.length, false);
    if (!size) break;
    const dataStart = pos + id.length + size.length;
    if (ENTER.has(id.value)) { pos = dataStart; continue; }
    if (size.unknown) return null; // cannot skip an unknown-size element we do not understand
    const dataEnd = dataStart + size.value;
    if (dataEnd > b.length) {
      // Truncated final element (e.g. recorder stopped mid-write): stop reading.
      break;
    }
    if (id.value === ID.TimecodeScale) scaleNs = readUint(b, dataStart, size.value) || scaleNs;
    else if (id.value === ID.Duration) headerDuration = readFloat(b, dataStart, size.value) || 0;
    else if (id.value === ID.Timecode) clusterTc = readUint(b, dataStart, size.value);
    else if (id.value === ID.SimpleBlock || id.value === ID.Block) {
      const track = readVint(b, dataStart, false);
      if (track) {
        const p = dataStart + track.length;
        const rel = (b[p] << 8 | b[p + 1]) << 16 >> 16; // signed int16
        const ts = clusterTc + rel;
        if (prevTs >= 0 && ts > prevTs) lastDelta = ts - prevTs;
        prevTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
    }
    pos = dataEnd;
  }
  const fromBlocks = maxTs >= 0 ? ((maxTs + (lastDelta || 20)) * scaleNs) / 1e9 : 0;
  const fromHeader = (headerDuration * scaleNs) / 1e9;
  const d = Math.max(fromBlocks, fromHeader);
  return d > 0 ? d : null;
}

// ---------------------------------------------------------------- Ogg
function oggDuration(b: Uint8Array): number | null {
  // Codec from the first packet of the first page.
  const segs = b[26];
  const payload = 27 + segs;
  const head = String.fromCharCode(...b.subarray(payload, payload + 8));
  let rate: number;
  let preSkip = 0;
  if (head === 'OpusHead') {
    rate = 48_000; // Opus granule positions are always at 48 kHz
    preSkip = b[payload + 10] | (b[payload + 11] << 8);
  } else if (head.slice(1, 7) === 'vorbis') {
    rate = new DataView(b.buffer, b.byteOffset + payload + 12, 4).getUint32(0, true);
  } else {
    return null;
  }
  // Last page carrying a valid granule position.
  for (let i = b.length - 27; i >= 0; i--) {
    if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) {
      const dv = new DataView(b.buffer, b.byteOffset + i + 6, 8);
      const lo = dv.getUint32(0, true);
      const hi = dv.getUint32(4, true);
      if (hi === 0xffffffff && lo === 0xffffffff) continue; // -1: no packet ends on this page
      const granule = hi * 2 ** 32 + lo;
      return rate > 0 ? Math.max(0, granule - preSkip) / rate : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- MP4 / ISO BMFF
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts']);

interface Mp4State {
  movieScale: number; movieDuration: number;
  trackScale: number; trackDuration: number; sttsTotal: number;
  trexDefaultDuration: number; fragmentDuration: number;
  fragEnd: number;
  // per-traf scratch
  tfdt: number; tfhdDefault: number; trafSum: number; inTraf: boolean;
}

function u32(b: Uint8Array, p: number): number { return readUint(b, p, 4); }
function u64(b: Uint8Array, p: number): number { return readUint(b, p, 8); }

function walkBoxes(b: Uint8Array, start: number, end: number, s: Mp4State): void {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(b, pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    let header = 8;
    if (size === 1) { size = u64(b, pos + 8); header = 16; } else if (size === 0) size = end - pos;
    if (size < header) return;
    const boxEnd = Math.min(pos + size, end);
    const d = pos + header; // payload start
    if (CONTAINERS.has(type)) {
      if (type === 'traf') { s.inTraf = true; s.tfdt = -1; s.tfhdDefault = 0; s.trafSum = 0; }
      walkBoxes(b, d, boxEnd, s);
      if (type === 'traf') {
        // Without tfdt, fragments follow each other: continue from the previous end.
        const base = s.tfdt >= 0 ? s.tfdt : s.fragEnd;
        s.fragEnd = Math.max(s.fragEnd, base + s.trafSum);
        s.inTraf = false;
      }
    } else if (type === 'mvhd' || type === 'mdhd') {
      const v1 = b[d] === 1;
      const scale = u32(b, d + (v1 ? 20 : 12));
      const dur = v1 ? u64(b, d + 24) : u32(b, d + 16);
      if (type === 'mvhd') { s.movieScale = scale; s.movieDuration = dur; } else { s.trackScale = scale; s.trackDuration = dur; }
    } else if (type === 'stts') {
      const n = u32(b, d + 4);
      for (let i = 0, p = d + 8; i < n && p + 8 <= boxEnd; i++, p += 8) s.sttsTotal += u32(b, p) * u32(b, p + 4);
    } else if (type === 'trex') {
      s.trexDefaultDuration = u32(b, d + 12);
    } else if (type === 'mehd') {
      s.fragmentDuration = b[d] === 1 ? u64(b, d + 4) : u32(b, d + 4);
    } else if (type === 'tfhd' && s.inTraf) {
      const flags = readUint(b, d + 1, 3);
      let p = d + 8; // version/flags + track_ID
      if (flags & 0x01) p += 8;
      if (flags & 0x02) p += 4;
      if (flags & 0x08) s.tfhdDefault = u32(b, p);
    } else if (type === 'tfdt' && s.inTraf) {
      s.tfdt = b[d] === 1 ? u64(b, d + 4) : u32(b, d + 4);
    } else if (type === 'trun' && s.inTraf) {
      const flags = readUint(b, d + 1, 3);
      const count = u32(b, d + 4);
      let p = d + 8;
      if (flags & 0x01) p += 4;
      if (flags & 0x04) p += 4;
      const perSample = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
      if (flags & 0x100) {
        for (let i = 0; i < count && p + 4 <= boxEnd; i++, p += perSample) s.trafSum += u32(b, p);
      } else {
        s.trafSum += count * (s.tfhdDefault || s.trexDefaultDuration);
      }
    }
    pos = pos + size;
  }
}

function mp4Duration(b: Uint8Array): number | null {
  const s: Mp4State = {
    movieScale: 0, movieDuration: 0, trackScale: 0, trackDuration: 0, sttsTotal: 0,
    trexDefaultDuration: 0, fragmentDuration: 0, fragEnd: 0, tfdt: 0, tfhdDefault: 0, trafSum: 0, inTraf: false,
  };
  walkBoxes(b, 0, b.length, s);
  const candidates: number[] = [];
  if (s.movieScale) candidates.push(s.movieDuration / s.movieScale, s.fragmentDuration / s.movieScale);
  if (s.trackScale) candidates.push(s.trackDuration / s.trackScale, s.sttsTotal / s.trackScale, s.fragEnd / s.trackScale);
  const d = Math.max(0, ...candidates.filter((x) => Number.isFinite(x)));
  return d > 0 ? d : null;
}
