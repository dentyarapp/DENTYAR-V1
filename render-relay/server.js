import http from "node:http";
import { Readable } from "node:stream";

const AUTH_HOSTS = new Set([
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com"
]);
const DATABASE_HOSTS = new Set([
  "dentyar-458d9-default-rtdb.firebaseio.com",
  "dentyar-458d9-default-rtdb.europe-west1.firebasedatabase.app"
]);
const SDK_HOST = "www.gstatic.com";
const SDK_PREFIX = "/firebasejs/10.12.5/";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Firebase-AppCheck,X-Client-Version,X-Firebase-GMPID",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function sendText(res, status, message, origin, contentType = "text/plain; charset=utf-8") {
  const body = Buffer.from(message);
  res.writeHead(status, {
    ...cors(origin),
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const incoming = new URL(req.url || "/", "http://localhost");
  const origin = req.headers.origin || "*";

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(origin));
    res.end();
    return;
  }

  const parts = incoming.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !["auth", "db", "sdk"].includes(parts[0])) {
    sendText(res, 200, "DENTYAR relay ready", origin);
    return;
  }

  const kind = parts.shift();
  const host = parts.shift();
  const remainingPath = "/" + parts.join("/");
  const allowed =
    kind === "auth" ? AUTH_HOSTS.has(host) :
    kind === "db" ? DATABASE_HOSTS.has(host) :
    kind === "sdk" ? host === SDK_HOST && remainingPath.startsWith(SDK_PREFIX) :
    false;

  if (!allowed) {
    sendText(res, 403, "Upstream is not allowed", origin);
    return;
  }

  const target = new URL("https://" + host + "/" + parts.join("/") + incoming.search);
  const headers = new Headers(req.headers);
  for (const key of [
    "host", "origin", "connection", "content-length",
    "cf-connecting-ip", "cf-ipcountry", "cf-ray", "x-forwarded-for"
  ]) headers.delete(key);

  try {
    const method = req.method || "GET";
    const hasBody = !["GET", "HEAD"].includes(method);
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "follow"
    });

    const responseHeaders = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(cors(origin))) responseHeaders.set(key, value);
    for (const key of [
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailers", "transfer-encoding", "upgrade"
    ]) responseHeaders.delete(key);
    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("content-security-policy-report-only");
    responseHeaders.delete("x-frame-options");
    responseHeaders.set("Cache-Control", "no-store");

    res.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()));
    if (!upstream.body || method === "HEAD") {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    sendText(res, 502, JSON.stringify({ error: "DENTYAR_RELAY_UPSTREAM_FAILED" }), origin, "application/json; charset=utf-8");
  }
});

const port = Number(process.env.PORT || 10000);
server.listen(port, "0.0.0.0", () => {
  console.log("DENTYAR relay listening on port " + port);
});
