import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { capturesDir, dataDir, loadConfig } from "./config";

export type CaptureKind = "image" | "gif" | "video";

export interface CaptureSource {
  appName?: string;
  windowTitle?: string;
  displayId?: string;
}

export interface CaptureItem {
  id: string;
  kind: CaptureKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  createdAt: string; // ISO
  source?: CaptureSource;
  thumbnailUrl: string; // 로컬 API 상대경로
  fileUrl: string; // 로컬 API 상대경로
  usedAt?: string | null;
}

interface AddInput {
  buffer: Buffer;
  thumbnail: Buffer;
  mimeType: string;
  kind?: CaptureKind;
  width?: number;
  height?: number;
  source?: CaptureSource;
  ext?: string;
}

function indexPath(): string {
  return path.join(dataDir(), "captures.json");
}
function fileName(id: string, ext: string): string {
  return `${id}.${ext}`;
}

/** 캡처 로컬 저장소 — 파일은 capturesDir, 메타는 captures.json. 변경 시 'change' 이벤트. */
export class CaptureStore extends EventEmitter {
  private items: (CaptureItem & { ext: string })[] = [];

  constructor() {
    super();
    this.load();
    this.prune();
  }

  private load() {
    try {
      const raw = fs.readFileSync(indexPath(), "utf8");
      this.items = JSON.parse(raw);
    } catch {
      this.items = [];
    }
  }
  private persist() {
    try {
      fs.writeFileSync(indexPath(), JSON.stringify(this.items, null, 2), "utf8");
    } catch (e) {
      console.error("[store] persist 실패:", e);
    }
  }

  /** 공개 목록(newest first) — 내부 ext는 감춘다. */
  list(): CaptureItem[] {
    return this.items
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(({ ext: _ext, ...rest }) => rest);
  }
  get(id: string): (CaptureItem & { ext: string }) | undefined {
    return this.items.find((i) => i.id === id);
  }
  filePath(id: string): string | null {
    const it = this.get(id);
    return it ? path.join(capturesDir(), fileName(it.id, it.ext)) : null;
  }
  thumbPath(id: string): string | null {
    const it = this.get(id);
    return it ? path.join(capturesDir(), `${it.id}.thumb.png`) : null;
  }

  add(input: AddInput): CaptureItem {
    const id = crypto.randomUUID();
    const ext = input.ext ?? "png";
    const kind = input.kind ?? "image";
    const stamp = new Date().toISOString();
    const dir = capturesDir();
    fs.writeFileSync(path.join(dir, fileName(id, ext)), input.buffer);
    fs.writeFileSync(path.join(dir, `${id}.thumb.png`), input.thumbnail);

    const item: CaptureItem & { ext: string } = {
      id,
      ext,
      kind,
      fileName: `buggle-${stamp.slice(0, 19).replace(/[:T]/g, "-")}.${ext}`,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.byteLength,
      width: input.width,
      height: input.height,
      createdAt: stamp,
      source: input.source,
      thumbnailUrl: `/captures/${id}/thumb`,
      fileUrl: `/captures/${id}/file`,
      usedAt: null,
    };
    this.items.unshift(item);
    this.prune();
    this.persist();
    this.emit("change");
    return item;
  }

  markUsed(id: string): boolean {
    const it = this.get(id);
    if (!it) return false;
    it.usedAt = new Date().toISOString();
    this.persist();
    this.emit("change");
    return true;
  }

  remove(id: string): boolean {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    const it = this.items[idx];
    this.items.splice(idx, 1);
    for (const p of [path.join(capturesDir(), fileName(it.id, it.ext)), path.join(capturesDir(), `${it.id}.thumb.png`)]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* 이미 없음 */
      }
    }
    this.persist();
    this.emit("change");
    return true;
  }

  /** 보관 정책 — 오래된 항목(기간 초과) + 최대 개수 초과분을 오래된 것부터 삭제. */
  prune() {
    const cfg = loadConfig();
    const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
    const survivors = this.items.filter((i) => new Date(i.createdAt).getTime() >= cutoff);
    const removed = this.items.filter((i) => !survivors.includes(i));
    // 최신순 정렬 후 maxItems 초과분 잘라내기
    survivors.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const keep = survivors.slice(0, cfg.maxItems);
    const overflow = survivors.slice(cfg.maxItems);
    for (const it of [...removed, ...overflow]) {
      for (const p of [path.join(capturesDir(), fileName(it.id, it.ext)), path.join(capturesDir(), `${it.id}.thumb.png`)]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* 무시 */
        }
      }
    }
    const changed = keep.length !== this.items.length;
    this.items = keep;
    if (changed) {
      this.persist();
      this.emit("change");
    }
  }
}

export const store = new CaptureStore();
