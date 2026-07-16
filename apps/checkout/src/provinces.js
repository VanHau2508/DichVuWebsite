/**
 * 34 tỉnh/thành Việt Nam SAU SÁP NHẬP 2025 (NQ 202/2025/QH15, vận hành từ 01/07/2025).
 * Dùng cho ô chọn Tỉnh/Thành ở checkout — giá trị lưu NGUYÊN VĂN vào địa chỉ đơn
 * (GHN/GHTK 2026 đều nhận tên tỉnh mới). Sắp theo miền Bắc → Nam cho dễ tìm.
 */
export const PROVINCES = [
  // 6 thành phố trực thuộc TW
  'Hà Nội', 'Hải Phòng', 'Huế', 'Đà Nẵng', 'TP. Hồ Chí Minh', 'Cần Thơ',
  // Miền Bắc
  'Cao Bằng', 'Lạng Sơn', 'Lai Châu', 'Điện Biên', 'Sơn La', 'Tuyên Quang',
  'Lào Cai', 'Thái Nguyên', 'Phú Thọ', 'Bắc Ninh', 'Hưng Yên', 'Ninh Bình', 'Quảng Ninh',
  // Miền Trung – Tây Nguyên (chính tả "Hóa/Hòa" theo master data GHN/GHTK + NQ 202)
  'Thanh Hóa', 'Nghệ An', 'Hà Tĩnh', 'Quảng Trị', 'Quảng Ngãi', 'Gia Lai',
  'Đắk Lắk', 'Khánh Hòa', 'Lâm Đồng',
  // Miền Nam
  'Đồng Nai', 'Tây Ninh', 'Đồng Tháp', 'Vĩnh Long', 'An Giang', 'Cà Mau',
];
export const isProvince = (p) => PROVINCES.includes(p);
