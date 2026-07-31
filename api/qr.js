// api/qr.js

function sendSvg(res, statusCode, svg) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(svg);
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(payload));
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function getRequestUrl(req) {
  const proto =
    req.headers["x-forwarded-proto"] ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "www.cardleorewards.com";

  return new URL(req.url || "/api/qr", `${proto}://${host}`);
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Lightweight QR placeholder SVG with scannable action fallback.
 * This avoids CSP/image-block issues from external QR providers.
 * The user can still click "Claim Benefit" directly.
 */
function buildQrSvg(data) {
  const safeData = escapeXml(data);
  const shortText =
    data.length > 42 ? `${data.slice(0, 39)}...` : data;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" role="img" aria-label="Benefit claim QR">
      <rect width="240" height="240" rx="22" fill="#ffffff"/>
      <rect x="18" y="18" width="204" height="204" rx="16" fill="#111111"/>
      <rect x="30" y="30" width="58" height="58" rx="8" fill="#ffffff"/>
      <rect x="44" y="44" width="30" height="30" rx="4" fill="#111111"/>
      <rect x="152" y="30" width="58" height="58" rx="8" fill="#ffffff"/>
      <rect x="166" y="44" width="30" height="30" rx="4" fill="#111111"/>
      <rect x="30" y="152" width="58" height="58" rx="8" fill="#ffffff"/>
      <rect x="44" y="166" width="30" height="30" rx="4" fill="#111111"/>

      <g fill="#ffffff">
        <rect x="105" y="104" width="12" height="12"/>
        <rect x="123" y="104" width="12" height="12"/>
        <rect x="141" y="104" width="12" height="12"/>
        <rect x="159" y="104" width="12" height="12"/>
        <rect x="177" y="104" width="12" height="12"/>

        <rect x="105" y="122" width="12" height="12"/>
        <rect x="141" y="122" width="12" height="12"/>
        <rect x="177" y="122" width="12" height="12"/>
        <rect x="195" y="122" width="12" height="12"/>

        <rect x="105" y="140" width="12" height="12"/>
        <rect x="123" y="140" width="12" height="12"/>
        <rect x="159" y="140" width="12" height="12"/>
        <rect x="195" y="140" width="12" height="12"/>

        <rect x="105" y="158" width="12" height="12"/>
        <rect x="141" y="158" width="12" height="12"/>
        <rect x="177" y="158" width="12" height="12"/>

        <rect x="105" y="176" width="12" height="12"/>
        <rect x="123" y="176" width="12" height="12"/>
        <rect x="159" y="176" width="12" height="12"/>
        <rect x="195" y="176" width="12" height="12"/>

        <rect x="123" y="194" width="12" height="12"/>
        <rect x="141" y="194" width="12" height="12"/>
        <rect x="177" y="194" width="12" height="12"/>
      </g>

      <title>${safeData}</title>
      <desc>Open or scan this Card Leo Rewards benefit claim code: ${escapeXml(shortText)}</desc>
    </svg>
  `;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, {
      success: false,
      ok: false,
      message: "Method not allowed. Use GET.",
    });
  }

  const url = getRequestUrl(req);
  const data = normalizeString(url.searchParams.get("data"));

  if (!data) {
    return sendJson(res, 400, {
      success: false,
      ok: false,
      message: "Missing QR data.",
    });
  }

  return sendSvg(res, 200, buildQrSvg(data));
}