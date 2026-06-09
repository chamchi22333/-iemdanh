const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

loadEnvFile(path.join(__dirname, ".env"));

const REQUESTED_PORT = Number(process.env.PORT || 3000);
const TOKEN_SECONDS = 20;
const SESSION_SECONDS = 180;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "attendance.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "attendance";

const sessions = new Map();
let token = "";
let tokenExpiresAt = 0;

ensureDataFile();
rotateToken();
setInterval(rotateToken, TOKEN_SECONDS * 1000);
setInterval(cleanupSessions, 30 * 1000);

let actualPort = REQUESTED_PORT;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/display") {
      return serveFile(res, path.join(PUBLIC_DIR, "display.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/checkin") {
      const incomingToken = url.searchParams.get("t") || "";
      if (!isCurrentToken(incomingToken)) {
        return serveFile(res, path.join(PUBLIC_DIR, "expired.html"), "text/html; charset=utf-8", 410);
      }

      const sessionId = crypto.randomBytes(18).toString("base64url");
      sessions.set(sessionId, {
        token: incomingToken,
        expiresAt: Date.now() + SESSION_SECONDS * 1000,
        used: false
      });

      const html = fs
        .readFileSync(path.join(PUBLIC_DIR, "checkin.html"), "utf8")
        .replace("__SESSION_ID__", escapeHtml(sessionId))
        .replace("__SESSION_SECONDS__", String(SESSION_SECONDS));
      return send(res, 200, "text/html; charset=utf-8", html);
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const submissions = await readSubmissions();
      const checkinUrl = `${getPublicBaseUrl(req)}/checkin?t=${token}`;
      return json(res, 200, {
        token,
        tokenSeconds: TOKEN_SECONDS,
        expiresAt: tokenExpiresAt,
        remainingSeconds: Math.max(0, Math.ceil((tokenExpiresAt - Date.now()) / 1000)),
        checkinUrl,
        submissions
      });
    }

    if (req.method === "GET" && url.pathname === "/api/qr.svg") {
      const data = url.searchParams.get("data") || `${getPublicBaseUrl(req)}/checkin?t=${token}`;
      const svg = qrSvg(data);
      return send(res, 200, "image/svg+xml; charset=utf-8", svg, {
        "Cache-Control": "no-store"
      });
    }

    if (req.method === "POST" && url.pathname === "/api/submit") {
      const body = await readJson(req);
      const result = await addSubmission(body);
      return json(res, result.status, result.payload);
    }

    if (req.method === "POST" && url.pathname === "/api/clear") {
      await clearSubmissions();
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/export.xlsx") {
      const meetingName = url.searchParams.get("meeting") || "Diem danh";
      const workbook = buildXlsx(await readSubmissions(), meetingName);
      return send(res, 200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", workbook, {
        "Content-Disposition": `attachment; filename="diem-danh-hoi-thao.xlsx"`,
        "Cache-Control": "no-store"
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/")) {
      const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(PUBLIC_DIR, safePath);
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return serveFile(res, filePath, contentType(filePath));
      }
    }

    return send(res, 404, "text/plain; charset=utf-8", "Not found");
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, message: "Server error" });
  }
});

startServer(REQUESTED_PORT);

function startServer(port) {
  actualPort = port;
  server.listen(port, "0.0.0.0", () => {
    const local = `http://localhost:${actualPort}`;
    const lan = `http://${getLanAddress()}:${actualPort}`;
    console.log(`Man hinh QR: ${local}`);
    console.log(`Dia chi LAN:  ${lan}`);
    console.log(`Luu du lieu:  ${hasSupabase() ? `Supabase table "${SUPABASE_TABLE}"` : "file data/attendance.json"}`);
    console.log("Dat PUBLIC_URL neu can dung dia chi khac, vi du PUBLIC_URL=http://192.168.1.20:3000 npm start");
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && !process.env.PORT && actualPort < REQUESTED_PORT + 10) {
    const nextPort = actualPort + 1;
    console.log(`Cong ${actualPort} dang duoc su dung, chuyen sang cong ${nextPort}...`);
    startServer(nextPort);
    return;
  }

  if (error.code === "EADDRINUSE") {
    console.error(`Cong ${actualPort} dang duoc su dung. Hay dung server cu hoac chay voi PORT cong khac, vi du: PORT=3001 npm start`);
    process.exit(1);
  }

  throw error;
});

function rotateToken() {
  token = crypto.randomBytes(7).toString("base64url");
  tokenExpiresAt = Date.now() + TOKEN_SECONDS * 1000;
}

function isCurrentToken(value) {
  return Boolean(value && value === token && Date.now() <= tokenExpiresAt);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt < now || session.used) sessions.delete(id);
  }
}

async function addSubmission(body) {
  const sessionId = String(body.sessionId || "");
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now() || session.used) {
    return { status: 410, payload: { ok: false, message: "Mã điểm danh đã hết hạn. Vui lòng quét lại QR mới." } };
  }

  const fullName = titleCaseVietnamese(String(body.fullName || "").trim());
  const unit = String(body.unit || "").trim();
  const studentId = String(body.studentId || "").trim().toUpperCase();
  const confirmed = body.confirmed === true;

  if (!fullName || !unit || !studentId || !confirmed) {
    return { status: 400, payload: { ok: false, message: "Vui lòng nhập đủ thông tin và tích xác nhận tham gia." } };
  }

  const duplicate = await hasDuplicateStudentId(studentId);
  if (duplicate) {
    return { status: 409, payload: { ok: false, message: "Mã sinh viên này đã được điểm danh." } };
  }

  const item = {
    timestamp: formatTimestamp(new Date()),
    fullName,
    unit,
    studentId,
    confirmed: "Có"
  };

  const saved = await saveSubmission(item);
  if (!saved.ok) {
    if (saved.duplicate) {
      return { status: 409, payload: { ok: false, message: "Mã sinh viên này đã được điểm danh." } };
    }
    return { status: 500, payload: { ok: false, message: "Không lưu được dữ liệu điểm danh. Vui lòng thử lại." } };
  }

  session.used = true;
  return { status: 200, payload: { ok: true, message: "Đã ghi nhận điểm danh.", item } };
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) writeSubmissions([]);
}

async function readSubmissions() {
  if (hasSupabase()) {
    return readSupabaseSubmissions();
  }

  return readLocalSubmissions();
}

function readLocalSubmissions() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeSubmissions(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), "utf8");
}

async function hasDuplicateStudentId(studentId) {
  if (hasSupabase()) {
    return hasSupabaseStudentId(studentId);
  }

  const submissions = readLocalSubmissions();
  return submissions.some((row) => row.studentId.toUpperCase() === studentId);
}

async function saveSubmission(item) {
  if (hasSupabase()) {
    return saveSupabaseSubmission(item);
  }

  const currentRows = readLocalSubmissions();
  currentRows.push(item);
  writeSubmissions(currentRows);
  return { ok: true };
}

async function clearSubmissions() {
  if (hasSupabase()) {
    await supabaseRequest("DELETE", `/${SUPABASE_TABLE}?student_id=not.is.null`, null, {
      Prefer: "return=minimal"
    });
    return;
  }

  writeSubmissions([]);
}

function hasSupabase() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

async function readSupabaseSubmissions() {
  const rows = await supabaseRequest("GET", `/${SUPABASE_TABLE}?select=timestamp,full_name,unit,student_id,confirmed&order=created_at.asc`);
  return rows.map(fromSupabaseRow);
}

async function hasSupabaseStudentId(studentId) {
  const encoded = encodeURIComponent(studentId);
  const rows = await supabaseRequest("GET", `/${SUPABASE_TABLE}?select=student_id&student_id=eq.${encoded}&limit=1`);
  return rows.length > 0;
}

async function saveSupabaseSubmission(item) {
  try {
    await supabaseRequest("POST", `/${SUPABASE_TABLE}`, toSupabaseRow(item), {
      Prefer: "return=minimal"
    });
    return { ok: true };
  } catch (error) {
    if (error.status === 409 || /duplicate key/i.test(error.message || "")) {
      return { ok: false, duplicate: true };
    }
    console.error(error);
    return { ok: false };
  }
}

function toSupabaseRow(item) {
  return {
    timestamp: item.timestamp,
    full_name: item.fullName,
    unit: item.unit,
    student_id: item.studentId,
    confirmed: item.confirmed
  };
}

function fromSupabaseRow(row) {
  return {
    timestamp: row.timestamp || "",
    fullName: row.full_name || "",
    unit: row.unit || "",
    studentId: row.student_id || "",
    confirmed: row.confirmed || ""
  };
}

function supabaseRequest(method, pathName, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/v1${pathName}`, SUPABASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...extraHeaders
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(text || `Supabase request failed with ${res.statusCode}`);
          error.status = res.statusCode;
          reject(error);
          return;
        }

        if (!text) {
          resolve([]);
          return;
        }

        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function serveFile(res, filePath, type, status = 200) {
  return send(res, status, type, fs.readFileSync(filePath));
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    ...headers
  });
  res.end(body);
}

function json(res, status, body) {
  return send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  return `http://${getLanAddress()}:${actualPort}`;
}

function getLanAddress() {
  const nets = os.networkInterfaces();
  for (const addresses of Object.values(nets)) {
    for (const net of addresses || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function titleCaseVietnamese(value) {
  return value
    .toLocaleLowerCase("vi-VN")
    .replace(/(^|\s|-)(\p{L})/gu, (match, prefix, char) => prefix + char.toLocaleUpperCase("vi-VN"))
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildXlsx(rows, meetingName = "Diem danh") {
  const sheetName = xlsxSheetName(meetingName);
  const headers = [
    "Họ và tên (Viết hoa chữ cái đầu)",
    "Đơn vị",
    "Mã sinh viên",
    "Xác nhận tham gia"
  ];
  const data = [headers, ...rows.map((row) => [
    row.fullName,
    row.unit,
    row.studentId,
    row.confirmed
  ])];

  const sheetData = data
    .map((row, rIndex) => {
      const cells = row
        .map((value, cIndex) => {
          const ref = `${columnName(cIndex + 1)}${rIndex + 1}`;
          const style = rIndex === 0 ? ' s="1"' : "";
          return `<c r="${ref}" t="inlineStr"${style}><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rIndex + 1}">${cells}</row>`;
    })
    .join("");

  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF5E3D8C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="20" customWidth="1"/><col min="4" max="4" width="20" customWidth="1"/></cols><sheetData>${sheetData}</sheetData><autoFilter ref="A1:D${Math.max(1, data.length)}"/></worksheet>`
  };

  return zip(files);
}

function xlsxSheetName(value) {
  const name = String(value || "Diem danh")
    .replace(/[\[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
  return name || "Diem danh";
}

function columnName(index) {
  let name = "";
  while (index > 0) {
    const mod = (index - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    index = Math.floor((index - mod) / 26);
  }
  return name;
}

function zip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function qrSvg(text) {
  const matrix = qrMatrix(text);
  const border = 4;
  const scale = 10;
  const size = matrix.length + border * 2;
  const rects = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix.length; x++) {
      if (matrix[y][x]) {
        rects.push(`<rect x="${(x + border) * scale}" y="${(y + border) * scale}" width="${scale}" height="${scale}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size * scale} ${size * scale}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">${rects.join("")}</g></svg>`;
}

function qrMatrix(text) {
  const version = 5;
  const size = 17 + version * 4;
  const dataCodewords = 108;
  const eccCodewords = 26;
  const data = encodeQrData(text, dataCodewords);
  const ecc = reedSolomonRemainder(data, reedSolomonDivisor(eccCodewords));
  const codewords = [...data, ...ecc];

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const qr = createBaseMatrix(size, version);
    drawCodewords(qr, codewords, mask);
    drawFormatBits(qr, mask);
    const penalty = qrPenalty(qr.modules);
    if (!best || penalty < best.penalty) best = { modules: qr.modules, penalty };
  }
  return best.modules;
}

function encodeQrData(text, capacity) {
  const bytes = Array.from(Buffer.from(text, "utf8"));
  if (bytes.length > 104) {
    throw new Error("QR URL qua dai. Hay dat PUBLIC_URL ngan hon.");
  }

  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(Number.parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  return data;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function createBaseMatrix(size, version) {
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  drawFinder(set, 3, 3);
  drawFinder(set, size - 4, 3);
  drawFinder(set, 3, size - 4);

  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  drawAlignment(set, 30, 30);
  reserveFormat(set, size);
  set(8, 4 * version + 9, true);

  return { modules, reserved };
}

function drawFinder(set, cx, cy) {
  for (let y = -4; y <= 4; y++) {
    for (let x = -4; x <= 4; x++) {
      const dist = Math.max(Math.abs(x), Math.abs(y));
      set(cx + x, cy + y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(set, cx, cy) {
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      const dist = Math.max(Math.abs(x), Math.abs(y));
      set(cx + x, cy + y, dist !== 1);
    }
  }
}

function reserveFormat(set, size) {
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      set(8, i, false);
      set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
}

function drawCodewords(qr, codewords, mask) {
  const bits = [];
  for (const word of codewords) appendBits(bits, word, 8);
  const size = qr.modules.length;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!qr.reserved[y][x]) {
          const bit = bitIndex < bits.length ? bits[bitIndex++] === 1 : false;
          qr.modules[y][x] = bit !== maskBit(mask, x, y);
        }
      }
    }
    upward = !upward;
  }
}

function drawFormatBits(qr, mask) {
  const bits = formatBits(mask);
  const size = qr.modules.length;
  const set = (x, y, bit) => {
    qr.modules[y][x] = bit;
    qr.reserved[y][x] = true;
  };

  for (let i = 0; i <= 5; i++) set(8, i, getBit(bits, i));
  set(8, 7, getBit(bits, 6));
  set(8, 8, getBit(bits, 7));
  set(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, getBit(bits, i));

  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, getBit(bits, i));
  set(8, size - 8, true);
}

function formatBits(mask) {
  const ecl = 1;
  const data = (ecl << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (((rem >>> i) & 1) !== 0) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function qrPenalty(modules) {
  const size = modules.length;
  let penalty = 0;

  for (let y = 0; y < size; y++) {
    let runColor = modules[y][0];
    let runLength = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLength++;
      } else {
        if (runLength >= 5) penalty += runLength - 2;
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    if (runLength >= 5) penalty += runLength - 2;
  }

  for (let x = 0; x < size; x++) {
    let runColor = modules[0][x];
    let runLength = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLength++;
      } else {
        if (runLength >= 5) penalty += runLength - 2;
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    if (runLength >= 5) penalty += runLength - 2;
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y][x];
      if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) {
        penalty += 3;
      }
    }
  }

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  penalty += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  return penalty;
}

function reedSolomonDivisor(degree) {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i++) {
      result[i] ^= gfMultiply(divisor[i], factor);
    }
  }
  return result;
}

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
