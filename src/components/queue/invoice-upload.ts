import { DOCUMENT_MAX_BYTES } from "@/lib/domain/checkin-document";

export function validateInvoiceFile(file: Pick<File, "size" | "name" | "type">) {
  if (file.size <= 0 || file.size > DOCUMENT_MAX_BYTES)
    throw new Error("Escolha uma foto ou PDF de até 10 MB. Seu preenchimento foi mantido.");
  // Some camera/file pickers omit the MIME type. The server checks the bytes.
  if (!/\.(jpe?g|png|heic|heif|pdf)$/i.test(file.name) &&
      !["image/jpeg", "image/png", "image/heic", "image/heif", "application/pdf"].includes(file.type))
    throw new Error("Use uma foto JPEG, PNG, HEIC/HEIF ou um PDF.");
}

function put(url: string, body: Blob, range: string, progress: (bytes: number) => void) {
  return new Promise<{ status: number; range: string | null }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.timeout = 90_000;
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("Content-Range", range);
    request.upload.onprogress = (event) => progress(event.loaded);
    request.onload = () => resolve({ status: request.status, range: request.getResponseHeader("Range") });
    request.onerror = () => reject(new Error("A conexão foi interrompida. Tente novamente para retomar o envio."));
    request.ontimeout = () => reject(new Error("O envio demorou demais. Tente novamente para retomá-lo."));
    request.send(body);
  });
}

/** Resume the same private object; no auth token is forwarded to Storage. */
export async function uploadInvoice(file: File, url: string, progress: (percent: number) => void) {
  const destination = new URL(url);
  if (destination.protocol !== "https:" || destination.hostname !== "storage.googleapis.com" ||
      destination.username || destination.password || destination.port)
    throw new Error("O destino do envio é inválido. Atualize a fila e tente novamente.");
  let offset = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Also probes on a user retry, so already acknowledged bytes are preserved.
      const status = await put(url, new Blob(), `bytes */${file.size}`, () => {});
      if (status.status === 200 || status.status === 201) { progress(100); return; }
      if (status.status !== 308) throw new Error("Não foi possível consultar o envio.");
      const match = /^bytes=0-(\d+)$/.exec(status.range ?? "");
      offset = match ? Number(match[1]) + 1 : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size)
        throw new Error("O resultado do envio não pôde ser confirmado.");
      const response = await put(url, file.slice(offset), `bytes ${offset}-${file.size - 1}/${file.size}`,
        (bytes) => progress(Math.min(99, Math.round((offset + bytes) / file.size * 100))));
      if (response.status === 200 || response.status === 201) { progress(100); return; }
    } catch { /* Reconcile the same resumable session before the next attempt. */ }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error("Não foi possível concluir o envio. O arquivo e seu preenchimento foram mantidos; tente novamente.");
}
