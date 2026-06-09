const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const core = require("../../server.js");

const TOKEN_SECONDS = 20;
const SESSION_SECONDS = 180;

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl || `https://${event.headers.host || "localhost"}${event.path || "/"}`);
    const pathname = normalizePath(url.pathname);

    if (event.httpMethod === "GET" && pathname === "/state") {
      const state = await getState(event);
      return json(200, state);
    }

    if (event.httpMethod === "GET" && pathname === "/qr.svg") {
      const data = url.searchParams.get("data") || (await getState(event)).checkinUrl;
      return response(200, "image/svg+xml; charset=utf-8", core.qrSvg(data), {
        "Cache-Control": "no-store"
      });
    }

    if (event.httpMethod === "GET" && pathname === "/checkin") {
      const incomingToken = url.searchParams.get("t") || "";
      if (!isCurrentToken(incomingToken)) {
        const expired = fs.readFileSync(path.join(__dirname, "../../public/expired.html"), "utf8");
        return response(410, "text/html; charset=utf-8", expired);
      }

      const sessionId = signSession({
        token: incomingToken,
        expiresAt: Date.now() + SESSION_SECONDS * 1000
      });
      const html = fs
        .readFileSync(path.join(__dirname, "../../public/checkin.html"), "utf8")
        .replace("__SESSION_ID__", escapeHtml(sessionId))
        .replace("__SESSION_SECONDS__", String(SESSION_SECONDS));
      return response(200, "text/html; charset=utf-8", html);
    }

    if (event.httpMethod === "POST" && pathname === "/submit") {
      const body = JSON.parse(event.body || "{}");
      const result = await submitAttendance(body);
      return json(result.status, result.payload);
    }

    if (event.httpMethod === "POST" && pathname === "/clear") {
      await core.clearSubmissions();
      return json(200, { ok: true });
    }

    if (event.httpMethod === "GET" && pathname === "/export.xlsx") {
      const meetingName = url.searchParams.get("meeting") || "Diem danh";
      const workbook = core.buildXlsx(await core.readSubmissions(), meetingName);
      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="diem-danh-hoi-thao.xlsx"`,
          "Cache-Control": "no-store"
        },
        body: workbook.toString("base64")
      };
    }

    return response(404, "text/plain; charset=utf-8", "Not found");
  } catch (error) {
    console.error(error);
    return json(500, { ok: false, message: "Server error" });
  }
};

async function getState(event) {
  const tokenState = getTokenState();
  const baseUrl = getBaseUrl(event);
  return {
    token: tokenState.token,
    tokenSeconds: TOKEN_SECONDS,
    expiresAt: tokenState.expiresAt,
    remainingSeconds: tokenState.remainingSeconds,
    checkinUrl: `${baseUrl}/checkin?t=${tokenState.token}`,
    submissions: await core.readSubmissions()
  };
}

async function submitAttendance(body) {
  const session = verifySession(String(body.sessionId || ""));
  if (!session) {
    return { status: 410, payload: { ok: false, message: "Mã điểm danh đã hết hạn. Vui lòng quét lại QR mới." } };
  }

  const fullName = core.titleCaseVietnamese(String(body.fullName || "").trim());
  const unit = String(body.unit || "").trim();
  const studentId = String(body.studentId || "").trim().toUpperCase();
  const confirmed = body.confirmed === true;

  if (!fullName || !unit || !studentId || !confirmed) {
    return { status: 400, payload: { ok: false, message: "Vui lòng nhập đủ thông tin và tích xác nhận tham gia." } };
  }

  if (await core.hasDuplicateStudentId(studentId)) {
    return { status: 409, payload: { ok: false, message: "Mã sinh viên này đã được điểm danh." } };
  }

  const item = {
    timestamp: core.formatTimestamp(new Date()),
    fullName,
    unit,
    studentId,
    confirmed: "Có"
  };

  const saved = await core.saveSubmission(item);
  if (!saved.ok) {
    if (saved.duplicate) {
      return { status: 409, payload: { ok: false, message: "Mã sinh viên này đã được điểm danh." } };
    }
    return { status: 500, payload: { ok: false, message: "Không lưu được dữ liệu điểm danh. Vui lòng thử lại." } };
  }

  return { status: 200, payload: { ok: true, message: "Đã ghi nhận điểm danh.", item } };
}

function normalizePath(pathname) {
  if (pathname.startsWith("/.netlify/functions/api")) {
    return pathname.replace("/.netlify/functions/api", "") || "/";
  }
  if (pathname.startsWith("/api/")) {
    return pathname.replace("/api", "");
  }
  return pathname;
}

function getTokenState() {
  const now = Date.now();
  const windowId = Math.floor(now / (TOKEN_SECONDS * 1000));
  const windowStart = windowId * TOKEN_SECONDS * 1000;
  const expiresAt = windowStart + TOKEN_SECONDS * 1000;
  return {
    token: tokenForWindow(windowId),
    expiresAt,
    remainingSeconds: Math.max(0, Math.ceil((expiresAt - now) / 1000))
  };
}

function tokenForWindow(windowId) {
  return hmac(`qr:${windowId}`).slice(0, 12);
}

function isCurrentToken(value) {
  return Boolean(value && value === getTokenState().token);
}

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${hmac(encoded)}`;
}

function verifySession(value) {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature || hmac(encoded) !== signature) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.expiresAt || payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function hmac(value) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(value)
    .digest("base64url");
}

function getSecret() {
  return process.env.QR_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "local-dev-secret";
}

function getBaseUrl(event) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const proto = event.headers["x-forwarded-proto"] || "https";
  const host = event.headers.host;
  return `${proto}://${host}`;
}

function response(statusCode, contentType, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": contentType,
      ...headers
    },
    body
  };
}

function json(statusCode, body) {
  return response(statusCode, "application/json; charset=utf-8", JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
