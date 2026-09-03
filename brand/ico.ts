/** Minimal ICO container writer: PNG-compressed entries, one per size.
 * Kept in-repo so icon generation needs no extra dependency. */
export interface IcoEntry {
  /** Edge length in px (16..256). */
  size: number;
  /** Complete PNG file bytes for this size. */
  png: Buffer;
}

/** Builds an .ico file from PNG entries (Vista+ PNG-compressed format). */
export function buildIco(entries: IcoEntry[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icons
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = Buffer.alloc(entries.length * 16);
  entries.forEach((e, i) => {
    const p = i * 16;
    dir[p] = e.size >= 256 ? 0 : e.size; // width  (0 means 256)
    dir[p + 1] = e.size >= 256 ? 0 : e.size; // height (ICO squares use square art)
    dir[p + 2] = 0; // palette count
    dir[p + 3] = 0; // reserved
    dir.writeUInt16LE(1, p + 4); // color planes
    dir.writeUInt16LE(32, p + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}
