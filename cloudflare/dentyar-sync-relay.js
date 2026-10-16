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
  "dentyar-458d9-default-rtdb.europe-west1.firebasedatabase.app",
  "dentyar-458d9-default-rtdb.europe-west1.firebasedatabase.app"
]);

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
    if (parts.length < 2 || !["auth", "db"].includes(parts[0])) {
      return new Response("DENTYAR relay ready", { status: 200, headers: cors(origin) });
    }

    const kind = parts.shift();
    const host = parts.shift();
    const allowed = kind === "auth" ? AUTH_HOSTS.has(host) : DATABASE_HOSTS.has(host);
    if (!allowed) {
      return new Response("Upstream is not allowed", { status: 403, headers: cors(origin) });
    }

    const target = new URL("https://" + host + "/" + parts.join("/") + incoming.search);
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
