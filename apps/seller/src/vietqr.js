/**
 * Sinh chuỗi VietQR (Napas 247, chuẩn EMVCo TLV). Mã hoá thành QR để app ngân
 * hàng quét → chuyển khoản với nội dung = mã đối soát (payment_ref).
 *
 * Tự viết + test bằng vector CRC chuẩn (CRC-16/CCITT-FALSE của "123456789" = 0x29B1).
 */

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, không reflect.
export function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

// TLV: ID(2) + LEN(2) + VALUE.
const tlv = (id, val) => id + String(val.length).padStart(2, '0') + val;

/**
 * @param {{bankBin:string, accountNumber:string, amountVnd:number, content:string}} p
 * @returns {string} chuỗi VietQR đầy đủ (kèm CRC)
 */
export function buildVietQR({ bankBin, accountNumber, amountVnd, content }) {
  const merchant =
    tlv('00', 'A000000727') + // GUID napas
    tlv('01', tlv('00', bankBin) + tlv('01', accountNumber)) +
    tlv('02', 'QRIBFTTA'); // chuyển tới tài khoản

  let payload =
    tlv('00', '01') + // payload format
    tlv('01', '12') + // dynamic (có số tiền)
    tlv('38', merchant) +
    tlv('53', '704') + // VND
    tlv('54', String(amountVnd)) +
    tlv('58', 'VN') +
    tlv('62', tlv('08', content)); // nội dung = payment_ref

  payload += '6304'; // ID+LEN của CRC, tính CRC gồm cả phần này
  const crc = crc16(payload).toString(16).toUpperCase().padStart(4, '0');
  return payload + crc;
}

/** Kiểm CRC của một chuỗi VietQR (4 hex cuối). */
export function verifyVietQR(qr) {
  if (qr.length < 8) return false;
  const body = qr.slice(0, -4);
  const crc = qr.slice(-4).toUpperCase();
  return crc16(body).toString(16).toUpperCase().padStart(4, '0') === crc;
}
