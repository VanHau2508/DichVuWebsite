// Khi chạy ngoài Docker, dùng trực tiếp bản reader trong seller; compose mount cùng file
// vào /app/xlsx-read.js để image BFF giữ build context nhỏ.
export { readXlsx, isXlsxMagic } from '../seller/src/xlsx-read.js';
