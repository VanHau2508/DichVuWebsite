const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
};

function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, raw) => {
    const key = raw.toLowerCase();
    if (Object.hasOwn(ENTITIES, key)) return ENTITIES[key];
    const n = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

/** Chuyển HTML TikTok thành văn bản an toàn và rút ảnh mô tả ra thư viện riêng. */
export function htmlToText(html) {
  const images = [];
  let text = String(html ?? '');
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const url = decodeEntities(src?.[1] ?? src?.[2] ?? src?.[3] ?? '').trim();
    if (url) images.push(url);
    return '';
  });
  text = text
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div)>/gi, '\n\n')
    .replace(/<\/(?:ul|ol)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  text = decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, images };
}
