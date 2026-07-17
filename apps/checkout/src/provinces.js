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

/**
 * Bản đồ VÙNG MIỀN tĩnh (Bắc/Trung/Nam) cho phí ship 2 bậc nội miền / liên miền.
 * Đủ 34/34 tỉnh (15 Bắc + 11 Trung + 8 Nam) — có test chống drift với PROVINCES.
 */
export const REGION_OF = {
  'Hà Nội': 'bac', 'Hải Phòng': 'bac', 'Cao Bằng': 'bac', 'Lạng Sơn': 'bac', 'Lai Châu': 'bac', 'Điện Biên': 'bac', 'Sơn La': 'bac', 'Tuyên Quang': 'bac', 'Lào Cai': 'bac', 'Thái Nguyên': 'bac', 'Phú Thọ': 'bac', 'Bắc Ninh': 'bac', 'Hưng Yên': 'bac', 'Ninh Bình': 'bac', 'Quảng Ninh': 'bac',
  'Huế': 'trung', 'Đà Nẵng': 'trung', 'Thanh Hóa': 'trung', 'Nghệ An': 'trung', 'Hà Tĩnh': 'trung', 'Quảng Trị': 'trung', 'Quảng Ngãi': 'trung', 'Gia Lai': 'trung', 'Đắk Lắk': 'trung', 'Khánh Hòa': 'trung', 'Lâm Đồng': 'trung',
  'TP. Hồ Chí Minh': 'nam', 'Cần Thơ': 'nam', 'Đồng Nai': 'nam', 'Tây Ninh': 'nam', 'Đồng Tháp': 'nam', 'Vĩnh Long': 'nam', 'An Giang': 'nam', 'Cà Mau': 'nam',
};
export const regionOf = (p) => REGION_OF[p] ?? null; // null = KHÔNG BIẾT vùng
