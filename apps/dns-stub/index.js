/**
 * DNS stub — CHỈ dev/e2e. Trả bản ghi TXT theo yêu cầu để test xác minh custom domain (A5)
 * một cách XÁC ĐỊNH (không phụ thuộc DNS thật). KHÔNG có trong prod.
 *
 *   - UDP :5353  — máy chủ DNS tối giản, chỉ trả TXT cho tên đã đăng ký (else NXDOMAIN).
 *   - HTTP :8600 — kênh điều khiển: POST /set {name, txt} đăng ký; POST /clear xoá hết.
 *
 * e2e: thêm domain → lấy verification_token → POST /set {_nentang-verify.<host>, token} →
 * trỏ resolver của worker vào stub → POST worker /internal/verify-sweep → verified_at bật.
 */
import dgram from 'node:dgram';
import http from 'node:http';

const records = new Map(); // tên (lowercase) → chuỗi TXT

// Đọc QNAME (chuỗi nhãn [len][bytes]... kết thúc bằng 0) từ offset.
function parseName(buf, offset) {
  const labels = [];
  let o = offset;
  while (o < buf.length && buf[o] !== 0) {
    const len = buf[o];
    labels.push(buf.slice(o + 1, o + 1 + len).toString('latin1'));
    o += 1 + len;
  }
  return { name: labels.join('.'), end: o + 1 };
}

const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => {
  try {
    const id = msg.readUInt16BE(0);
    const { name, end } = parseName(msg, 12);
    const qtype = msg.readUInt16BE(end);            // 16 = TXT
    const question = msg.slice(12, end + 4);         // qname + qtype + qclass
    const txt = records.get(name.toLowerCase());
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(1, 4);                       // QDCOUNT = 1
    const parts = [header, question];
    if (qtype === 16 && txt) {
      header.writeUInt16BE(0x8180, 2);               // QR=1, RD=1, RA=1, RCODE=0
      header.writeUInt16BE(1, 6);                     // ANCOUNT = 1
      const t = Buffer.from(txt, 'latin1');
      const rdata = Buffer.concat([Buffer.from([t.length]), t]); // TXT: [len][chars] (≤255)
      const ans = Buffer.alloc(12);
      ans.writeUInt16BE(0xC00C, 0);                  // NAME = con trỏ tới offset 12
      ans.writeUInt16BE(16, 2);                      // TYPE = TXT
      ans.writeUInt16BE(1, 4);                       // CLASS = IN
      ans.writeUInt32BE(30, 6);                      // TTL
      ans.writeUInt16BE(rdata.length, 10);           // RDLENGTH
      parts.push(ans, rdata);
    } else {
      header.writeUInt16BE(0x8183, 2);               // QR=1, RD=1, RA=1, RCODE=3 (NXDOMAIN)
    }
    udp.send(Buffer.concat(parts), rinfo.port, rinfo.address);
  } catch { /* bỏ qua gói méo */ }
});
udp.bind(5353, () => console.log('dns-stub: UDP 5353'));

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/set') {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      try { const { name, txt } = JSON.parse(b); records.set(String(name).toLowerCase(), String(txt)); res.writeHead(200); res.end('{"ok":true}'); }
      catch { res.writeHead(400); res.end('{"error":"bad json"}'); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/clear') { records.clear(); res.writeHead(200); res.end('{"ok":true}'); return; }
  if (req.url === '/healthz') { res.writeHead(200); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
}).listen(8600, () => console.log('dns-stub: HTTP 8600'));
