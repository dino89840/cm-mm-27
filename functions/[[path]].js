/*
 * Samusar proxy for Cloudflare Pages Functions
 *
 * File location:
 *   /functions/samusar/[[path]].js
 *
 * Proxy:
 *   /samusar/<path>
 *      -> https://www.samusar.com/<path>
 *
 * Features:
 * - GET / HEAD only
 * - Correct Referer translation
 * - Range / If-Range passthrough
 * - Manual redirect following
 * - Streaming without buffering video files
 * - HTML URL rewriting
 * - Cookie Domain and Path rewriting
 * - Video responses are never cached
 */

const ORIGIN = "https://www.samusar.com";

/*
 * If this file is:
 *   /functions/samusar/[[path]].js
 * keep this as "/samusar".
 *
 * If it is:
 *   /functions/[[path]].js
 * change it to "".
 */
const PROXY_PREFIX = "/samusar";

const MAX_REDIRECTS = 5;

const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Mobile Safari/537.36";

/**
 * Replace origin URLs inside HTML with proxy URLs.
 */
function rewriteHtml(html, proxyRoot) {
  const proxyWithSlash = proxyRoot.replace(/\/+$/, "") + "/";

  const replacements = [
    "https://www.samusar.com/",
    "http://www.samusar.com/",
    "https://samusar.com/",
    "http://samusar.com/",
    "//www.samusar.com/",
    "//samusar.com/",
  ];

  for (const value of replacements) {
    html = html.split(value).join(proxyWithSlash);
  }

  /*
   * Also handle escaped URLs sometimes found inside JavaScript:
   *
   * https:\/\/www.samusar.com\/get_file\/...
   */
  const escapedProxy =
    proxyRoot.replace(/\//g, "\\/").replace(/\/+$/, "") + "\\/";

  const escapedReplacements = [
    "https:\\/\\/www.samusar.com\\/",
    "http:\\/\\/www.samusar.com\\/",
    "https:\\/\\/samusar.com\\/",
    "http:\\/\\/samusar.com\\/",
  ];

  for (const value of escapedReplacements) {
    html = html.split(value).join(escapedProxy);
  }

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
    pathname.toLowerCase().endsWith(".m3u8")
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

function errorJson(error, message, status, extra = {}) {
  return new Response(
    JSON.stringify(
      {
        error,
        message,
        ...extra,
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
 * Convert:
 *
 * https://proxy.pages.dev/samusar/videos/123/
 *
 * into:
 *
 * https://www.samusar.com/videos/123/
 */
function translateReferer(clientReferer, incomingOrigin) {
  if (!clientReferer) {
    return ORIGIN + "/";
  }

  try {
    const refererUrl = new URL(clientReferer);

    if (refererUrl.origin !== incomingOrigin) {
      return ORIGIN + "/";
    }

    let pathname = refererUrl.pathname;

    if (
      PROXY_PREFIX &&
      (
        pathname === PROXY_PREFIX ||
        pathname.startsWith(PROXY_PREFIX + "/")
      )
    ) {
      pathname = pathname.slice(PROXY_PREFIX.length);
    }

    if (!pathname) {
      pathname = "/";
    }

    return (
      ORIGIN +
      pathname +
      refererUrl.search
    );
  } catch {
    return ORIGIN + "/";
  }
}

/**
 * Rewrite Set-Cookie:
 *
 * - Remove origin Domain
 * - Scope Path to /samusar/
 */
function rewriteSetCookie(cookie) {
  let result = cookie.replace(
    /;\s*Domain=[^;]*/gi,
    ""
  );

  const cookiePath =
    (PROXY_PREFIX || "") + "/";

  if (/;\s*Path=[^;]*/i.test(result)) {
    result = result.replace(
      /;\s*Path=[^;]*/i,
      "; Path=" + cookiePath
    );
  } else {
    result += "; Path=" + cookiePath;
  }

  return result;
}

/**
 * Read all Set-Cookie headers in different Workers runtime versions.
 */
function getSetCookieHeaders(headers) {
  if (
    typeof headers.getSetCookie === "function"
  ) {
    return headers.getSetCookie();
  }

  if (typeof headers.getAll === "function") {
    try {
      return headers.getAll("Set-Cookie");
    } catch {
      // Continue to fallback.
    }
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Follow redirects manually.
 *
 * This keeps Range / If-Range headers intact and prevents cookies
 * from being forwarded to an unrelated redirect host.
 */
async function fetchWithRedirects(
  initialUrl,
  method,
  initialHeaders
) {
  let currentUrl = new URL(initialUrl);
  let currentHeaders = new Headers(initialHeaders);

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount++
  ) {
    const response = await fetch(
      currentUrl.toString(),
      {
        method,
        headers: currentHeaders,
        redirect: "manual",

        /*
         * Do not allow fetch-layer caching for dynamic video tokens
         * and range responses.
         */
        cache: "no-store",
      }
    );

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: currentUrl,
        redirectCount,
      };
    }

    const location =
      response.headers.get("location");

    if (!location) {
      return {
        response,
        finalUrl: currentUrl,
        redirectCount,
      };
    }

    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error(
        "Too many upstream redirects"
      );
    }

    const nextUrl = new URL(
      location,
      currentUrl
    );

    /*
     * Do not leak samusar cookies to an external video CDN.
     */
    if (
      nextUrl.hostname !== currentUrl.hostname
    ) {
      currentHeaders.delete("cookie");
    }

    currentUrl = nextUrl;
  }

  throw new Error("Redirect loop detected");
}

export async function onRequest(context) {
  const { request, params } = context;

  const method = request.method.toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    return new Response(
      "Method not allowed",
      {
        status: 405,
        headers: {
          allow: "GET, HEAD",
          "cache-control": "no-store",
        },
      }
    );
  }

  /*
   * Pages catch-all params are returned as an array.
   */
  const rawSegments = Array.isArray(params.path)
    ? params.path
    : params.path
      ? [params.path]
      : [];

  /*
   * Encode each segment separately so query strings and slashes
   * cannot accidentally modify the origin URL.
   */
  const targetPath =
    "/" +
    rawSegments
      .map((segment) =>
        encodeURIComponent(segment)
      )
      .join("/");

  const incoming = new URL(request.url);

  const targetUrl = new URL(
    targetPath + incoming.search,
    ORIGIN
  );

  const proxyRoot =
    incoming.origin + PROXY_PREFIX;

  const forwardHeaders = new Headers();

  forwardHeaders.set(
    "User-Agent",
    BROWSER_UA
  );

  forwardHeaders.set(
    "Accept",
    request.headers.get("accept") || "*/*"
  );

  forwardHeaders.set(
    "Accept-Language",
    request.headers.get("accept-language") ||
      "en-US,en;q=0.9,my;q=0.8"
  );

  /*
   * Correctly remove /samusar from the proxy Referer.
   */
  const originReferer = translateReferer(
    request.headers.get("referer") || "",
    incoming.origin
  );

  forwardHeaders.set(
    "Referer",
    originReferer
  );

  /*
   * Some origins check the Origin header too.
   */
  if (request.headers.has("origin")) {
    forwardHeaders.set("Origin", ORIGIN);
  }

  const cookie =
    request.headers.get("cookie");

  if (cookie) {
    forwardHeaders.set(
      "Cookie",
      cookie
    );
  }

  /*
   * Forward range-related headers.
   */
  const rangeHeaders = [
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
  ];

  for (const name of rangeHeaders) {
    const value =
      request.headers.get(name);

    if (value) {
      forwardHeaders.set(name, value);
    }
  }

  /*
   * Prevent compressed partial responses.
   * This is important for stable byte-range seeking.
   */
  if (
    request.headers.has("range") ||
    targetPath.startsWith("/get_file/")
  ) {
    forwardHeaders.set(
      "Accept-Encoding",
      "identity"
    );
  }

  let upstream;
  let finalUrl;
  let redirectCount = 0;

  try {
    const result =
      await fetchWithRedirects(
        targetUrl,
        method,
        forwardHeaders
      );

    upstream = result.response;
    finalUrl = result.finalUrl;
    redirectCount = result.redirectCount;
  } catch (err) {
    return errorJson(
      "origin_unreachable",
      "Could not reach the upstream server: " +
        String(
          (err && err.message) || err
        ),
      502
    );
  }

  const contentType =
    upstream.headers.get("content-type") ||
    "";

  const lowerType =
    contentType.toLowerCase();

  const isHtml =
    lowerType.includes("text/html");

  const isVideo = isVideoPath(
    targetPath,
    contentType
  );

  const isImage =
    isImageContent(contentType);

  const outHeaders = new Headers();

  /*
   * Safe response headers to pass through.
   */
  const passThroughHeaders = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
    "etag",
    "last-modified",
    "expires",
    "vary",
  ];

  for (const name of passThroughHeaders) {
    const value =
      upstream.headers.get(name);

    if (value) {
      outHeaders.set(name, value);
    }
  }

  /*
   * Forward and rewrite cookies.
   */
  const setCookies =
    getSetCookieHeaders(upstream.headers);

  for (const setCookie of setCookies) {
    outHeaders.append(
      "set-cookie",
      rewriteSetCookie(setCookie)
    );
  }

  /*
   * Cache policy.
   */
  if (
    isHtml &&
    isListingPath(targetPath)
  ) {
    outHeaders.set(
      "cache-control",
      "public, max-age=300"
    );
  } else if (isImage) {
    outHeaders.set(
      "cache-control",
      "public, max-age=3600"
    );
  } else {
    /*
     * Detail page tokens, video files and other dynamic responses.
     */
    outHeaders.set(
      "cache-control",
      "no-store, no-cache, must-revalidate"
    );

    outHeaders.set(
      "pragma",
      "no-cache"
    );

    outHeaders.set(
      "expires",
      "0"
    );
  }

  /*
   * Helpful debug headers.
   * These do not expose the complete signed video URL.
   */
  outHeaders.set(
    "x-proxy-upstream-status",
    String(upstream.status)
  );

  outHeaders.set(
    "x-proxy-redirects",
    String(redirectCount)
  );

  outHeaders.set(
    "x-proxy-range-request",
    request.headers.has("range")
      ? "yes"
      : "no"
  );

  if (finalUrl) {
    outHeaders.set(
      "x-proxy-final-host",
      finalUrl.hostname
    );
  }

  /*
   * HTML must be read and rewritten.
   * Do not copy the old Content-Length because rewriting changes
   * the body size.
   */
  if (method !== "HEAD" && isHtml) {
    let html;

    try {
      html = await upstream.text();
    } catch (err) {
      return errorJson(
        "origin_read_failed",
        String(
          (err && err.message) || err
        ),
        502
      );
    }

    html = rewriteHtml(
      html,
      proxyRoot
    );

    outHeaders.delete(
      "content-length"
    );

    return new Response(html, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  }

  /*
   * A HEAD response and statuses such as 204 / 304 must not have a body.
   */
  const hasNoBody =
    method === "HEAD" ||
    upstream.status === 204 ||
    upstream.status === 205 ||
    upstream.status === 304;

  /*
   * Video and binary files are streamed directly.
   * upstream.body is not converted to ArrayBuffer, so the entire
   * video is not loaded into Worker memory.
   */
  return new Response(
    hasNoBody ? null : upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    }
  );
}
