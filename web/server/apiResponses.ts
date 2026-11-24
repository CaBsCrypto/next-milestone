import { ApiError } from './uploadAuth.ts';

export const MAX_DOCUMENT_BYTES = 80 * 1024;

export async function readLimitedBody(body: ReadableStream<Uint8Array> | null, length: string | null, maximum: number): Promise<Uint8Array> {
  if (length && Number(length) > maximum) throw new ApiError(413, 'El documento supera el tamaño permitido.');
  if (!body) throw new ApiError(400, 'Faltan los datos de la solicitud.');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ApiError(413, 'El documento supera el tamaño permitido.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

export async function requestJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new ApiError(415, 'La solicitud debe contener JSON.');
  }
  const bytes = await readLimitedBody(request.body, request.headers.get('content-length'), MAX_DOCUMENT_BYTES);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ApiError(400, 'La solicitud no contiene JSON válido.');
  }
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
  return jsonResponse({ error: 'No se pudo completar la carga. Intenta nuevamente.' }, 502);
}
