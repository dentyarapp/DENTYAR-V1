/**
 * DENTYAR Firebase connectivity relay.
 * Deploy as a Cloudflare Worker, then set DENTYAR_SYNC_PROXY_URL in the app
 * to the deployed HTTPS URL. This is a transport relay only; Firebase Auth
 * and Realtime Database security rules remain authoritative.
 *
 * Allowed upstreams are deliberately restricted to the DENTYAR Firebase
 * project and Firebase Authentication endpoints. This is NOT an open proxy.
 */
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

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const parts = incoming.pathname.split("/").filter(Boolean);
    let kind, host, targetPath;

    // RTDB is configured with the relay origin as its host. Route its root-relative
    // long-poll requests to the explicit, allow-listed Firebase database host.
    // The Firebase RTDB SDK consumes the "ns" query parameter to determine
    // the database namespace and may discard other custom query parameters
    // such as "dbHost". Therefore route by the fixed, allow-listed namespace
    // instead of relying on a non-standard parameter surviving SDK parsing.
    const isRtdbRequest =
      incoming.searchParams.get("ns") === "dentyar-458d9" &&
      !["auth", "sdk", "db"].includes(parts[0] || "");

    if (isRtdbRequest) {
      kind = "db";
      host = "dentyar-458d9-default-rtdb.firebaseio.com";
      targetPath = incoming.pathname;
    } else {
      if (parts.length < 2 || !["auth", "db", "sdk"].includes(parts[0])) {
        return new Response("DENTYAR relay ready", { status: 200, headers: cors(origin) });
      }
      kind = parts.shift();
      host = parts.shift();
      targetPath = "/" + parts.join("/");
    }

    const allowed = kind === "auth" ? AUTH_HOSTS.has(host) : kind === "db" ? DATABASE_HOSTS.has(host) : (host === SDK_HOST && targetPath.startsWith(SDK_PREFIX));
    if (!allowed) {
      return new Response("Upstream is not allowed", { status: 403, headers: cors(origin) });
    }

    const target = new URL("https://" + host + targetPath);
    const forwardedSearch = new URLSearchParams(incoming.searchParams);
    target.search = forwardedSearch.toString() ? "?" + forwardedSearch.toString() : "";
    const headers = new Headers(request.headers);
    headers.delete("Host");
    headers.delete("Origin");
    headers.delete("CF-Connecting-IP");
    headers.delete("CF-IPCountry");
    headers.delete("CF-Ray");

    try {
      const upstream = await fetch(new Request(target.toString(), {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "follow"
      }));
      const responseHeaders = new Headers(upstream.headers);
      for (const [key, value] of Object.entries(cors(origin))) responseHeaders.set(key, value);
      responseHeaders.delete("content-security-policy");
      responseHeaders.delete("content-security-policy-report-only");
      responseHeaders.delete("x-frame-options");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    } catch (_) {
      return new Response(JSON.stringify({ error: "DENTYAR_RELAY_UPSTREAM_FAILED" }), {
        status: 502,
        headers: { ...cors(origin), "Content-Type": "application/json" }
      });
    }
  }
};
