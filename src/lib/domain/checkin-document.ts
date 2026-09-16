/** Document policy shared by the API and its acceptance tests. Sizes are decimal bytes. */
export const DOCUMENT_MAX_BYTES = 10_000_000;
export const DOCUMENT_SESSION_MS = 60 * 60 * 1000;
export const DOCUMENT_TEMP_MS = 24 * 60 * 60 * 1000;
export type DocumentReceipt = { sessionId: string; skip: boolean };
export type VisitDocument = {
  status: "pending" | "received";
  sessionId: string;
  current: null | {
    id: string; object: string; generation: string; name: string; size: number;
    contentType: string; sha256: string; receivedAtIso: string;
    previewStatus: "pending" | "ready" | "failed" | "not-applicable";
    previewObject?: string;
  };
};
export function detectDocumentType(bytes: Uint8Array): string | null {
  const at = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length>=5 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217) return "image/jpeg";
  if (bytes.length>=20 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v) && at(bytes.length-8,bytes.length-4)==="IEND") return "image/png";
  if (at(0,5) === "%PDF-" && at(Math.max(0,bytes.length-1024),bytes.length).includes("%%EOF")) return "application/pdf";
  if (at(4,8) === "ftyp") {
    const brands = [at(8,12)];
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    for (let i=16; i+4<=Math.min(boxSize,bytes.length,256); i+=4) brands.push(at(i,i+4));
    if (brands.some(b => ["heic","heix","hevc","hevx"].includes(b))) return "image/heic";
    if (brands.some(b => ["mif1","msf1"].includes(b))) return "image/heif";
  }
  return null;
}
export function assertDocumentSize(size: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > DOCUMENT_MAX_BYTES)
    throw new Error("Escolha uma foto ou PDF de até 10 MB.");
}
export function documentBlocksCall(document?: VisitDocument) {
  return document !== undefined && (document.status !== "received" || !document.current);
}
