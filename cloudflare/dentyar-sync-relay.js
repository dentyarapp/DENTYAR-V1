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

function cors(origin, requestedHeaders = "") {
  // Firebase Auth's SDK may add headers that vary by operation/version.
  // Echo only syntactically valid header names requested by the browser,
  // instead of maintaining a brittle partial allowlist. This relay still
  // restricts every upstream host/path below; CORS does not bypass Firebase
  // Authentication or Realtime Database rules.
  const validHeaderList = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*,\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+)*$/;
  const allowHeaders = requestedHeaders && validHeaderList.test(requestedHeaders)
    ? requestedHeaders
    : "Authorization,Content-Type,X-Firebase-AppCheck,X-Client-Version,X-Firebase-GMPID,X-Firebase-Client,X-Firebase-Locale";
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(origin, request.headers.get("Access-Control-Request-Headers") || "")
      });
    }

    // A privacy-preserving connectivity probe: request only a deliberately
    // nonexistent path and return status codes, never Firebase response data.
    // This distinguishes a reachable Worker from a Worker that can reach RTDB.
    if (incoming.pathname === "/health/firebase" && request.method === "GET") {
      const checks = await Promise.all(["dentyar-458d9-default-rtdb.firebaseio.com"].map(async (host) => {
        try {
          const upstream = await fetch("https://" + host + "/__dentyar_relay_probe_404__.json");
          const status = upstream.status;
          try { await upstream.body?.cancel(); } catch (_) {}
          return { host, status, reachable: status !== 502 && status !== 504 };
        } catch (_) {
          return { host, status: 0, reachable: false };
        }
      }));
      return new Response(JSON.stringify({
        relay: "ok",
        firebaseTransport: checks.every((item) => item.reachable) ? "reachable" : "unreachable",
        checks
      }), {
        status: 200,
        headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    const parts = incoming.pathname.split("/").filter(Boolean);
    const kind = parts[0] || "";
    let host = "";
    let upstreamPath = incoming.pathname;

    if (kind === "auth") {
      if (parts.length < 2 || !AUTH_HOSTS.has(parts[1])) {
        return new Response("Upstream is not allowed", { status: 403, headers: cors(origin) });
      }
      host = parts[1];
      upstreamPath = "/" + parts.slice(2).join("/");
    } else if (kind === "db") {
      if (parts.length < 2 || !DATABASE_HOSTS.has(parts[1])) {
        return new Response("Upstream is not allowed", { status: 403, headers: cors(origin) });
      }
      host = parts[1];
      upstreamPath = "/" + parts.slice(2).join("/");
    } else if (kind === "sdk") {
      if (parts.length < 3 || parts[1] !== SDK_HOST || !("/" + parts.slice(2).join("/")).startsWith(SDK_PREFIX)) {
        return new Response("Upstream is not allowed", { status: 403, headers: cors(origin) });
      }
      host = SDK_HOST;
      upstreamPath = "/" + parts.slice(2).join("/");
    } else {
      // Firebase Realtime Database SDK uses script/iframe long-poll requests
      // and may use WebSocket URLs. Those requests do not pass through fetch/XHR
      // hooks inside the page, so the app points databaseURL directly at this
      // Worker and this default route proxies only the known DENTYAR database.
      const ns = incoming.searchParams.get("ns") || "";
      if (ns !== "dentyar-458d9-default-rtdb") {
        if (incoming.pathname === "/" && !incoming.search) {
          return new Response("DENTYAR relay ready", { status: 200, headers: cors(origin) });
        }
        return new Response("Database namespace is not allowed", { status: 403, headers: cors(origin) });
      }
      host = "dentyar-458d9-default-rtdb.firebaseio.com"; // Canonical host for root /.lp, /.ws and /.json requests; do not use regional firebasedatabase.app here.
      if (!DATABASE_HOSTS.has(host)) {
        return new Response("Upstream is not allowed", { status: 403, headers: cors(origin) });
      }
    }

    const target = new URL("https://" + host + upstreamPath + incoming.search);
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

      // Firebase long-poll handshake advertises a sharded *.firebaseio.com host in
      // the "h" field. Rewrite only that shard hostname to this Worker origin so
      // follow-up /.lp requests continue through the relay instead of bypassing it.
      if (incoming.pathname === "/.lp" && upstream.ok) {
        let body = await upstream.text();
        const workerHost = incoming.host;
        body = body.replace(/("h"\\s*:\\s*")s-[a-z0-9-]+\\.firebaseio\\.com(")/gi, "$1" + workerHost + "$2");
        responseHeaders.delete("content-length");
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("etag");
        responseHeaders.delete("content-md5");
        return new Response(body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders
        });
      }

      // Firebase CDN ESM files can reference firebase-app.js by an absolute
      // gstatic URL. If that import bypasses this relay, the app/auth modules
      // load separate Firebase component registries and Auth reports:
      // "Component auth has not been registered yet". Keep every SDK module
      // on this exact relay origin so all imports share one module instance.
      if (kind === "sdk" && upstream.ok && /javascript|ecmascript/.test(responseHeaders.get("content-type") || "")) {
        let source = await upstream.text();
        const publicSdkBase = "https://www.gstatic.com/firebasejs/10.12.5/";
        const relaySdkBase = incoming.origin + "/sdk/www.gstatic.com/firebasejs/10.12.5/";
        source = source.split(publicSdkBase).join(relaySdkBase);
        responseHeaders.delete("content-length");
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("etag");
        responseHeaders.delete("content-md5");
        responseHeaders.set("content-type", "text/javascript; charset=utf-8");
        return new Response(source, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders
        });
      }

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

// Deployment trigger after GitHub Cloudflare secrets were updated.
