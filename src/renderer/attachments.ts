// Client-side image attachment rules; they mirror the limits main enforces so the user hears about a problem before sending.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 6;

export interface PendingImage { id: string; name: string; mime: string; dataBase64: string; preview: string }

/** Picks the files that may be added next to `existing` ones; `error` explains the first rejection. */
export function acceptImages(existing: number, files: File[]): { accepted: File[]; error: string } {
  const accepted: File[] = []; let error = '';
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type)) { error ||= `${f.name || 'This file'} is not a supported image. Use PNG, JPEG, GIF or WebP.`; continue; }
    if (f.size > MAX_IMAGE_BYTES) { error ||= `${f.name || 'This image'} is larger than 10 MB.`; continue; }
    if (existing + accepted.length >= MAX_IMAGES) { error ||= `You can attach up to ${MAX_IMAGES} images per message.`; continue; }
    accepted.push(f);
  }
  return { accepted, error };
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function readImage(file: File): Promise<PendingImage> {
  const preview = await readDataUrl(file);
  return { id: crypto.randomUUID(), name: file.name || 'pasted-image', mime: file.type, dataBase64: preview.slice(preview.indexOf(',') + 1), preview };
}
