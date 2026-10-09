/*
 * Samusar.com full proxy for the CM FLIX APK Myanmar category.
 *
 *   GET/HEAD /<path>  ->  https://www.samusar.com/<path>
 *
 * Phase: NO Bunny CDN — HTML, images and video all go through Pages.
 * A separate pages.dev project is used so any ToS/ban risk is isolated
 * from the main CM FLIX backend.
 *
 * Behaviour:
 * - Follows origin redirects internally (fetch default), so the client
 *   never sees a samusar.com URL in a Location header.
 * - Forwards request cookies to the origin; forwards Set-Cookie back
 *   (Domain attribute stripped so cookies scope to this proxy host).
 * - Forwards Range requests (video seeking returns proper 206).
 * - Translates a proxy-based Referer back to the samusar.com URL so
 *   origin referer checks keep working.
 * - Rewrites samusar.com URLs in HTML responses to this proxy's
 *   /samusar/ prefix, so browsing, thumbnails and video all stay on
 *   the proxy (client never needs to reach samusar.com directly).
 *
 * Cache policy:
 * - Listing HTML (/, /latest-updates*): public, max-age=300
 *     (new videos appear at the top within ~5 minutes)
 * - Images (content-type image/*): public, max-age=3600
 * - Detail HTML (/videos/*): no-store (player tokens are dynamic)
 * - Video (/get_file/* or content-type video/*): no-store, streamed
 * - Everything else: no-store
 */

const ORIGIN = "https://www.samusar.com";

const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function rewriteHtml(html, proxyBase) {
  // Every samusar.com URL -> this proxy. Covers:
  //   https://www.samusar.com/... , http://www.samusar.com/... ,
  //   //www.samusar.com/...  (page links, thumbnails, get_file URLs,
  //   and the video_url JS fields on detail pages)
  html = html
    .split("https://www.samusar.com/")
    .join(proxyBase + "/");
  html = html
    .split("http://www.samusar.com/")
    .join(proxyBase + "/");
  html = html
    .split("//www.samusar.com/")
    .join(proxyBase.replace(/^https?:/, "") + "/");
  return html;
}

function isListingPath(path) {
  return (
    path === "/" ||
    path === "" ||
    path.startsWith("/latest-updates")
  );
}

function isDetailPath(path) {
  return path.startsWith("/videos/");
}

function isVideoPath(path, contentType) {
  return (
    path.startsWith("/get_file/") ||
    (contentType || "").toLowerCase().startsWith("video/")
  );
}

function isImageContent(contentType) {
  return (contentType || "")
    .toLowerCase()
    .startsWith("image/");
}

function errorJson(error, message, status) {
  return new Response(
    JSON.stringify({ error, message }),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}

export async function onRequest(context) {
  const { request, params } = context;

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
    });
  }

  const segments = params.path || [];
  const targetPath =
    "/" +
    segments.map((s) => encodeURIComponent(s)).join("/");

  const incoming = new URL(request.url);
  const target = new URL(
    ORIGIN + targetPath + incoming.search
  );

  const fwdHeaders = new Headers();
  fwdHeaders.set("User-Agent", BROWSER_UA);
  fwdHeaders.set("Accept", "*/*");
  fwdHeaders.set(
    "Accept-Language",
    "en-US,en;q=0.9,my;q=0.8"
  );

  // Translate a proxy-based Referer back to the real samusar.com URL
  // so origin referer checks keep working for video files.
  const proxyBase = incoming.origin;
  const clientReferer =
    request.headers.get("referer") || "";
  if (clientReferer.startsWith(proxyBase)) {
    fwdHeaders.set(
      "Referer",
      proxyBase.length
        ? clientReferer.replace(proxyBase, ORIGIN)
        : ORIGIN + "/"
    );
  } else {
    fwdHeaders.set("Referer", ORIGIN + "/");
  }

  const cookie = request.headers.get("cookie");
  if (cookie) {
    fwdHeaders.set("Cookie", cookie);
  }

  // Video seeking: pass Range through so origin returns 206.
  const range = request.headers.get("range");
  if (range) {
    fwdHeaders.set("Range", range);
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers: fwdHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return errorJson(
      "origin_unreachable",
      "Could not reach samusar.com: " +
        String((err && err.message) || err),
      502
    );
  }

  const outHeaders = new Headers();
  const contentType =
    upstream.headers.get("content-type") || "";
  if (contentType) {
    outHeaders.set("content-type", contentType);
  }

  // Forward Set-Cookie, stripping Domain so cookies scope to proxy host.
  const getSetCookie =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
  for (const sc of getSetCookie) {
    outHeaders.append(
      "set-cookie",
      sc.replace(/;\s*[Dd]omain=[^;]*/g, "")
    );
  }

  const lowerType = contentType.toLowerCase();
  const isHtml = lowerType.includes("text/html");
  const video = isVideoPath(targetPath, contentType);
  const image = isImageContent(contentType);

  // ---- Cache policy ----
  if (isHtml && isListingPath(targetPath)) {
    // New uploads surface at the top within ~5 minutes.
    outHeaders.set(
      "cache-control",
      "public, max-age=300"
    );
  } else if (image) {
    outHeaders.set(
      "cache-control",
      "public, max-age=3600"
    );
  } else {
    // Detail HTML (dynamic tokens), video streams, and anything
    // else: never cache.
    outHeaders.set("cache-control", "no-store");
  }

  // ---- HTML: rewrite URLs to stay on the proxy ----
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
    outHeaders.set(
      "content-length",
      String(new TextEncoder().encode(html).length)
    );
    return new Response(html, {
      status: upstream.status,
      headers: outHeaders,
    });
  }

  // ---- Video / images / other: stream through untouched ----
  // Pass through length/range headers so players can seek.
  for (const h of [
    "content-length",
    "content-range",
    "accept-ranges",
  ]) {
    const v = upstream.headers.get(h);
    if (v) {
      outHeaders.set(h, v);
    }
  }

  return new Response(
    method === "HEAD" ? null : upstream.body,
    {
      status: upstream.status,
      headers: outHeaders,
    }
  );
}
