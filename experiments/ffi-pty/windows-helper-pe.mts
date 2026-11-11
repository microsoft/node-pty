import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface PeReader {
  readonly size: number;
  read(offset: number, length: number): Buffer;
}

export interface PeCertificateSniff {
  present: boolean;
  reason: string;
}

export function safePeRange(size: number, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(size) &&
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    size >= 0 &&
    offset >= 0 &&
    length >= 0 &&
    offset <= size &&
    length <= size - offset
  );
}

export function inspectPeCertificate(reader: PeReader): PeCertificateSniff {
  // Reject malformed or unsigned layouts as soon as the headers prove it; only
  // a plausible certificate table needs its 8-byte record header (110 bytes
  // requested total). The certificate payload is never read here.
  if (!Number.isSafeInteger(reader.size) || reader.size < 64)
    return { present: false, reason: "PE file is too small" };
  const read = (offset: number, length: number): Buffer | undefined => {
    if (!safePeRange(reader.size, offset, length)) return undefined;
    const data = reader.read(offset, length);
    return data.length === length ? data : undefined;
  };
  const dos = read(0, 64);
  if (!dos || dos.toString("ascii", 0, 2) !== "MZ")
    return { present: false, reason: "invalid DOS header" };
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < 64) return { present: false, reason: "PE header overlaps the DOS header" };
  const headers = read(peOffset, 26);
  if (!headers || headers.toString("binary", 0, 4) !== "PE\0\0")
    return { present: false, reason: "invalid PE header bounds or signature" };
  const optionalSize = headers.readUInt16LE(20);
  const magic = headers.readUInt16LE(24);
  const numberOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : -1;
  const directoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1;
  const securityEntryOffset = directoryOffset + 4 * 8;
  if (
    numberOffset < 0 ||
    optionalSize < securityEntryOffset + 8 ||
    !safePeRange(reader.size, peOffset + 24, optionalSize)
  ) {
    return { present: false, reason: "invalid PE optional header" };
  }
  const optionalOffset = peOffset + 24;
  const directoryCount = read(optionalOffset + numberOffset, 4);
  if (!directoryCount || directoryCount.readUInt32LE(0) < 5)
    return { present: false, reason: "PE security directory is absent" };
  const securityEntry = read(optionalOffset + securityEntryOffset, 8);
  if (!securityEntry) return { present: false, reason: "PE security directory is truncated" };
  const certificateOffset = securityEntry.readUInt32LE(0);
  const certificateSize = securityEntry.readUInt32LE(4);
  if (certificateOffset === 0 && certificateSize === 0)
    return { present: false, reason: "PE certificate table is absent" };
  if (
    certificateOffset === 0 ||
    certificateSize < 8 ||
    certificateOffset % 8 !== 0 ||
    certificateOffset < optionalOffset + optionalSize ||
    !safePeRange(reader.size, certificateOffset, certificateSize)
  ) {
    return { present: false, reason: "invalid PE certificate table bounds" };
  }
  const certificate = read(certificateOffset, 8);
  if (!certificate) return { present: false, reason: "PE certificate header is truncated" };
  const recordLength = certificate.readUInt32LE(0);
  const revision = certificate.readUInt16LE(4);
  const type = certificate.readUInt16LE(6);
  if (
    recordLength < 8 ||
    recordLength > certificateSize ||
    revision !== 0x0200 ||
    type !== 0x0002
  ) {
    return { present: false, reason: "invalid WIN_CERTIFICATE header" };
  }
  return { present: true, reason: "PE certificate table is present" };
}

export function sniffPeCertificate(path: string): PeCertificateSniff {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return { present: false, reason: `cannot open helper: ${String(error)}` };
  }
  try {
    const size = fstatSync(fd).size;
    return inspectPeCertificate({
      size,
      read: (offset, length) => {
        const data = Buffer.alloc(length);
        const bytesRead = readSync(fd, data, 0, length, offset);
        return bytesRead === length ? data : data.subarray(0, bytesRead);
      },
    });
  } catch (error) {
    return { present: false, reason: `cannot inspect PE helper: ${String(error)}` };
  } finally {
    closeSync(fd);
  }
}
