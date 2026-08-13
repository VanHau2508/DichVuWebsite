/**
 * SỐ ĐIỆN THOẠI KHÁCH — một quy tắc cho checkout, tài khoản khách và đơn do shop tạo.
 *
 * Cùng một người thường nhập `0912...`, `091 2...` hoặc `+84912...`. Nếu các đường ghi
 * chuẩn hoá khác nhau thì trần chống đơn ảo, gộp hồ sơ khách và đổi địa chỉ sẽ nhìn họ
 * thành nhiều người. Chuỗi có chữ hoặc ít hơn tám chữ số bị loại thay vì lặng lẽ lọc rác.
 */
export function canonPhone(value) {
  const raw = String(value ?? '').trim();
  if (!/^[0-9+\s.-]{8,20}$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length > 9) digits = '0' + digits.slice(2);
  return digits.length >= 8 ? digits : null;
}
