/** Plain-text preview of the first paragraph, never a model-generated extra response. */
export function notificationSummary(text: string): string {
  const paragraph = text.trim().split(/\r?\n\s*\r?\n/, 1)[0] ?? '';
  // Code/image-only openings are not useful previews. Do not leak link destinations.
  if (/^\s*(```|~~~)/.test(paragraph)) return '';
  const plain = paragraph
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const characters = Array.from(plain);
  return characters.length > 160 ? characters.slice(0, 159).join('').trimEnd() + '…' : plain;
}
