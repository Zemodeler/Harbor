// Two letters are enough to tell a handful of projects apart on the rail.
export function initials(name: string) {
  const words = name.split(/[\s_\-.]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}
// Downscale to a small square PNG so the icon stays tiny inside state.json.
export function toIcon(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // A data: URL, not a blob: URL: the CSP (index.html) allows img-src 'self' data: only.
    const bad = () => reject(new Error('That file is not an image Harbor can read.'));
    const reader = new FileReader();
    reader.onerror = bad;
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 96, c = document.createElement('canvas'); c.width = c.height = size;
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, side = Math.min(w, h);
        if (!side) return bad();
        c.getContext('2d')!.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = bad;
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
