/*
 * Samusar.com full proxy for the CM FLIX APK Myanmar category.
 *
 * File:
 *   functions/[[path]].js
 *
 * Routes:
 *   GET/HEAD /<path> -> https://www.samusar.com/<path>
 *
 * Important video behavior:
 * - Streams video without buffering the whole file in memory.
 * - Forwards Range and conditional Range headers.
 * - Uses Accept-Encoding: identity to keep byte offsets stable.
 * - Preserves Content-Range, Content-Length, ETag and Last-Modified.
 * - Follows redirects manually.
 * - Does not leak samusar cookies to a different redirect host.
 * - Allows short private browser caching for smoother seeking.
 */

const ORIGIN = "https://www.samusar.com";
const MAX_REDIRECTS = 6;

const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Mobile Safari/537.36";

/**
 * Rewrites samusar.com absolute URLs to the proxy host.
 *
 * Supports:
 *   https://www.samusar.com/path
 *   http://www.samusar.com/path
 *   https://samusar.com/path
 *   //www.samusar.com/path
 *   https:\/\/www.samusar.com\/path
 */
function rewriteHtml(html, proxyBase) {
  // Normal absolute URLs.
  html = html.replace(
    /https?:\/\/(?:www\.)?samusar\.com(?=\/|["'\s<])/gi,
    proxyBase
  );

  // Protocol-relative URLs.
  html = html.replace(
    /(^|[^:])\/\/(?:www\.)?samusar\.com(?=\/)/gi,
    (_, prefix) => prefix + proxyBase
  );

  // JSON/JavaScript escaped URLs:
  // https:\/\/www.samusar.com\/path
  const escapedProxyBase = proxyBase.replace(/\//g, "\\/");

  html = html.replace(
    /https?:\\\/\\\/(?:www\.)?samusar\.com(?=\\\/)/gi,
    escapedProxyBase
  );

  return html;
}

function isListingPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "" ||
    pathname.startsWith("/latest-updates")
  );
}

function isDetailPath(pathname) {
  return pathname.startsWith("/videos/");
}

function isVideoPath(pathname, contentType) {
  const type = (contentType || "").toLowerCase();

  return (
    pathname.startsWith("/get_file/") ||
    type.startsWith("video/") ||
    type.includes("application/vnd.apple.mpegurl") ||
    type.includes("application/x-mpegurl") ||
    type.includes("application/dash+xml")
  );
}

function isImageContent(contentType) {
  return (contentType || "")
    .toLowerCase()
    .startsWith("image/");
}

function isRedirectStatus(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function errorJson(error, message, status = 500) {
  return new Response(
    JSON.stringify(
      {
        error,
        message,
      },
      null,
      2
    ),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}

/**
 * Convert proxy Referer back to samusar.com Referer.
 */
function buildOriginReferer(request, proxyBase) {
  const clientReferer = request.headers.get("referer") || "";

  if (
    clientReferer === proxyBase ||
    clientReferer.startsWith(proxyBase + "/")
  ) {
    return ORIGIN + clientReferer.slice(proxyBase.length);
  }

  return ORIGIN + "/";
}

/**
 * Build headers sent to the upstream server.
 */
function buildForwardHeaders(request, proxyBase) {
  const headers = new Headers();

  headers.set("User-Agent", BROWSER_UA);
  headers.set(
    "Accept",
    request.headers.get("accept") || "*/*"
  );
  headers.set(
    "Accept-Language",
    request.headers.get("accept-language") ||
      "en-US,en;q=0.9,my;q=0.8"
  );

  /*
   * Important for byte-range correctness.
   *
   * If a compressed representation is used, the requested byte
   * positions may no longer match the actual video representation.
   */
  headers.set("Accept-Encoding", "identity");

  headers.set(
    "Referer",
    buildOriginReferer(request, proxyBase)
  );

  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.set("Cookie", cookie);
  }

  /*
   * Forward Range and conditional request headers.
   *
   * If-Range is especially important when the player resumes
   * or seeks using ETag / Last-Modified validators.
   */
  const forwardedHeaders = [
    "range",
    "if-range",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
  ];

  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  return headers;
}

/**
 * Fetch upstream while following redirects manually.
 *
 * This keeps Range headers on redirected video URLs while preventing
 * the samusar.com Cookie header from being leaked to another host.
 */
async function fetchWithRedirects({
  initialUrl,
  method,
  headers,
  signal,
}) {
  let currentUrl = new URL(initialUrl);
  let response = null;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount++
  ) {
    const currentHeaders = new Headers(headers);

    /*
     * Never forward samusar cookies to a third-party video/CDN host.
     */
    if (currentUrl.origin !== ORIGIN) {
      currentHeaders.delete("Cookie");
    }

    response = await fetch(currentUrl.toString(), {
      method,
      headers: currentHeaders,
      redirect: "manual",

      /*
       * Bypass Cloudflare subrequest cache.
       * Browser-facing caching is controlled separately below.
       */
      cache: "no-store",

      signal,
    });

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: currentUrl,
        redirectCount,
      };
    }

    const location = response.headers.get("location");

    if (!location) {
      return {
        response,
        finalUrl: currentUrl,
        redirectCount,
      };
    }

    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error(
        `Too many upstream redirects; limit=${MAX_REDIRECTS}`
      );
    }

    let nextUrl;

    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error(
        "Invalid upstream redirect Location header"
      );
    }

    if (
      nextUrl.protocol !== "https:" &&
      nextUrl.protocol !== "http:"
    ) {
      throw new Error(
        `Unsupported redirect protocol: ${nextUrl.protocol}`
      );
    }

    currentUrl = nextUrl;
  }

  throw new Error("Unexpected redirect processing failure");
}

/**
 * Get all Set-Cookie headers in different Workers runtime versions.
 */
function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  if (typeof headers.getAll === "function") {
    try {
      return headers.getAll("Set-Cookie");
    } catch {
      // Continue to fallback below.
    }
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Copy a header if the upstream response contains it.
 */
function copyHeader(source, destination, name) {
  const value = source.get(name);

  if (value !== null && value !== "") {
    destination.set(name, value);
  }
}

export async function onRequest(context) {
  const { request } = context;

  const method = request.method.toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "cache-control": "no-store",
      },
    });
  }

  const incoming = new URL(request.url);
  const proxyBase = incoming.origin;

  /*
   * Use the incoming encoded pathname directly.
   *
   * Re-encoding context.params.path can double-encode values such as:
   *   %20 -> %2520
   */
  const target = new URL(ORIGIN);
  target.pathname = incoming.pathname;
  target.search = incoming.search;

  const forwardedHeaders = buildForwardHeaders(
    request,
    proxyBase
  );

  let upstreamResult;

  try {
    upstreamResult = await fetchWithRedirects({
      initialUrl: target.toString(),
      method,
      headers: forwardedHeaders,
      signal: request.signal,
    });
  } catch (err) {
    return errorJson(
      "origin_unreachable",
      "Could not reach the upstream server: " +
        String((err && err.message) || err),
      502
    );
  }

  const upstream = upstreamResult.response;
  const finalUrl = upstreamResult.finalUrl;

  const contentType =
    upstream.headers.get("content-type") || "";

  const lowerType = contentType.toLowerCase();
  const isHtml = lowerType.includes("text/html");

  const video = isVideoPath(
    incoming.pathname,
    contentType
  );

  const image = isImageContent(contentType);

  const outHeaders = new Headers();

  /*
   * Basic representation headers.
   */
  if (contentType) {
    outHeaders.set("content-type", contentType);
  }

  copyHeader(
    upstream.headers,
    outHeaders,
    "content-language"
  );

  /*
   * Only forward samusar cookies.
   *
   * If the video redirects to a different storage/CDN host,
   * its cookies should not be scoped to this proxy domain.
   */
  if (finalUrl.origin === ORIGIN) {
    const setCookies = getSetCookieHeaders(
      upstream.headers
    );

    for (const cookie of setCookies) {
      const proxyCookie = cookie.replace(
        /;\s*Domain=[^;]*/gi,
        ""
      );

      outHeaders.append("set-cookie", proxyCookie);
    }
  }

  /*
   * HTML pages are read and rewritten.
   */
  if (method !== "HEAD" && isHtml) {
    let html;

    try {
      html = await upstream.text();
    } catch (err) {
      return errorJson(
        "origin_read_failed",
        String((err && err.message) || err),
        502
      );
    }

    html = rewriteHtml(html, proxyBase);

    if (isListingPath(incoming.pathname)) {
      outHeaders.set(
        "cache-control",
        "public, max-age=300"
      );
    } else if (isDetailPath(incoming.pathname)) {
      /*
       * Detail pages may contain temporary player tokens.
       */
      outHeaders.set(
        "cache-control",
        "no-store, no-transform"
      );
    } else {
      outHeaders.set(
        "cache-control",
        "no-store, no-transform"
      );
    }

    return new Response(html, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  }

  /*
   * Binary/video/image response headers.
   *
   * These are important for video seeking and resuming.
   */
  const passthroughHeaders = [
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
    "content-encoding",
    "etag",
    "last-modified",
    "expires",
    "vary",
  ];

  for (const name of passthroughHeaders) {
    copyHeader(upstream.headers, outHeaders, name);
  }

  /*
   * A valid 206 response inherently supports byte ranges.
   * Add Accept-Ranges if the origin omitted it.
   */
  if (
    upstream.status === 206 &&
    !outHeaders.has("accept-ranges")
  ) {
    outHeaders.set("accept-ranges", "bytes");
  }

  /*
   * Cache policy.
   */
  if (video) {
    /*
     * "private" prevents shared CDN caching but allows the device's
     * browser/player to reuse recently downloaded byte ranges.
     *
     * "no-transform" prevents compression/transformation that could
     * break byte positions.
     */
    outHeaders.set(
      "cache-control",
      "private, max-age=600, no-transform"
    );
  } else if (image) {
    outHeaders.set(
      "cache-control",
      "public, max-age=3600, no-transform"
    );
  } else {
    outHeaders.set(
      "cache-control",
      "no-store, no-transform"
    );
  }

  /*
   * Debugging headers.
   *
   * If the client sent Range:
   *   honored     = upstream returned 206
   *   unsatisfied = upstream returned 416
   *   ignored     = upstream returned something else, usually 200
   */
  const requestedRange = request.headers.get("range");

  if (requestedRange) {
    if (upstream.status === 206) {
      outHeaders.set(
        "x-proxy-range-result",
        "honored"
      );
    } else if (upstream.status === 416) {
      outHeaders.set(
        "x-proxy-range-result",
        "unsatisfied"
      );
    } else {
      outHeaders.set(
        "x-proxy-range-result",
        "ignored"
      );
    }
  } else {
    outHeaders.set(
      "x-proxy-range-result",
      "not-requested"
    );
  }

  outHeaders.set(
    "x-proxy-upstream-status",
    String(upstream.status)
  );

  outHeaders.set(
    "x-proxy-redirect-count",
    String(upstreamResult.redirectCount)
  );

  /*
   * Stream the upstream response directly.
   *
   * Do not call:
   *   arrayBuffer()
   *   blob()
   *   text()
   *
   * for video responses because those methods buffer the complete
   * video before returning it.
   */
  return new Response(
    method === "HEAD" ? null : upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    }
  );
}
