/**
 * igembed — lightweight Instagram embed fixer for Discord (Cloudflare Worker)
 *
 * Usage: replace `instagram.com` in any post/reel URL with your worker domain.
 *   https://www.instagram.com/reel/ABC123/  ->  https://<your-worker>/reel/ABC123/
 *
 * Behavior:
 *   - Discord gets a tnktok/fxTikTok-style rich embed: the HTML page links to a
 *     Mastodon-status-shaped JSON (`application/activity+json` alternate link)
 *     that Discord renders with the author's avatar, "Name (@username)", the
 *     caption, a bold ❤️/💬/▶️ stats line, the post timestamp, and an
 *     "igembed" footer. Other crawlers (Telegram, Slack, ...) fall back to the
 *     og:video / og:image tags on the page itself.
 *   - Real people get a 302 straight to the original Instagram post.
 *   - /video/:code, /image/:code and /pfp/:code proxy the media bytes so
 *     Discord never sees an expired signed CDN URL (the "video shows as an
 *     image" failure mode).
 *
 * Media resolution strategies, in order:
 *   1. The post page fetched with a Googlebot UA: Instagram SSRs a complete
 *      "xig_polaris_media" JSON payload for search engines — video_versions,
 *      image candidates, carousel items, caption, counts. Stable (it's what
 *      Google indexes) and needs no doc_id.
 *   2. GraphQL API (doc_id rotates every few weeks; override via DOC_ID env var)
 *   3. Username (from step 1's OG tags) -> web_profile_info API, which returns
 *      full video URLs for the account's ~12 most recent posts
 *   4. The /embed/captioned page (inlined gql_data JSON, IP-dependent)
 *   5. Instagram's own OG image/caption — never worse than a native embed
 * Results are cached for CACHE_TTL seconds (default 50 min, under the ~1 day
 * signed-URL expiry).
 */

const BOT_RE = /bot|discord|telegram|facebookexternalhit|whatsapp|slack|twitter|preview|embed|vkshare|skype|viber|line\/|pinterest/i;

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const CRAWLER_UA = "Googlebot/2.1 (+http://www.google.com/bot.html)";
const IG_APP_ID = "936619743392459";

const DEFAULT_DOC_ID = "25531498899829322"; // PolarisPostActionLoadPostQueryQuery
const DEFAULT_CACHE_TTL = 3000; // seconds

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      return new Response("igembed error: " + (err && err.message), { status: 500 });
    }
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  let path = url.pathname;
  const ua = request.headers.get("User-Agent") || "";

  // Clean mode: /c/ prefix (or ?c / ?clean / ?raw) serves crawlers the bare
  // media bytes — Discord renders just the video/image, no card, no text.
  let clean = ["c", "clean", "raw"].some((k) => url.searchParams.has(k));
  if (path === "/c" || path.startsWith("/c/")) {
    clean = true;
    path = path.slice(2) || "/";
  }

  if (path === "/" || path === "") return landingPage(url.host);
  if (path === "/favicon.ico" || path === "/robots.txt") return new Response(null, { status: 404 });

  // Media proxy endpoints (Discord's media proxy hits these; they must always work)
  let m = path.match(/^\/(video|image|pfp)\/([A-Za-z0-9_-]+)(?:\/(\d+))?(?:\.\w+)?$/);
  if (m) return proxyMedia(m[1], m[2], parseInt(m[3] || "1", 10), request, env, ctx);

  // Mastodon-style status JSON — Discord follows the activity+json alternate
  // link on the embed page, then re-fetches the status through the canonical
  // Mastodon REST path (/api/v1/statuses/:id) on the same host; both must
  // answer or Discord falls back to the OG tags. The id is numeric
  // (Mastodon-shaped): the shortcode base64-decoded, converted back losslessly.
  m = path.match(/^(?:\/users\/[^/]+\/statuses|\/api\/v1\/statuses)\/([A-Za-z0-9_-]+)/);
  if (m) return apStatus(/^\d+$/.test(m[1]) ? idToShortcode(m[1]) : m[1], url.host, env, ctx);

  if (path === "/oembed.json") return oembed(url);

  // Post URL shapes: /p/:code, /reel/:code, /reels/:code, /tv/:code, /:user/p/:code, /:user/reel/:code
  m = path.match(/^(?:\/[A-Za-z0-9_.]+)?\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);

  // Share links (/share/xyz, /share/reel/xyz) need one hop to instagram to resolve the canonical code
  if (!m && path.startsWith("/share/")) {
    const resolved = await resolveShareLink(path);
    if (resolved) m = resolved.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  }

  if (!m) {
    // Unknown path (profiles, stories, ...): just forward to Instagram
    return Response.redirect("https://www.instagram.com" + path + url.search, 302);
  }

  const kind = m[1] === "p" ? "p" : m[1] === "tv" ? "tv" : "reel";
  const code = m[2];
  const igUrl = `https://www.instagram.com/${kind}/${code}/`;

  // ?debug returns the resolved media JSON regardless of UA
  if (url.searchParams.has("debug")) {
    const media = await resolveMedia(code, env, ctx);
    return new Response(JSON.stringify(media, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Humans go straight to the real post — no interstitial
  if (!BOT_RE.test(ua)) return Response.redirect(igUrl, 302);

  const media = await resolveMedia(code, env, ctx);
  if (clean && !media.error) {
    return proxyMedia(media.isVideo && media.videoUrl ? "video" : "image", code, 1, request, env, ctx);
  }
  return embedPage(media, code, igUrl, url.host);
}

/* ---------------------------------- resolution ---------------------------------- */

async function resolveMedia(code, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://igembed.cache/v3/" + code);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  let page = null;
  try { page = await fetchBotPage(code); } catch (e) {}

  let media = page && page.media;
  if (!media) { try { media = await fromGraphql(code, env); } catch (e) {} }
  if (!media && page && page.og && page.og.username) {
    try { media = await fromProfileFeed(page.og.username, code); } catch (e) {}
  }
  if (!media) { try { media = await fromEmbedPage(code); } catch (e) {} }
  if (!media && page && page.og && page.og.imageUrl) media = page.og; // image-only, native parity
  if (!media) media = { error: true };

  // Full results cache long; degraded/error results cache briefly so a later
  // fetch can upgrade them once Instagram cooperates again.
  const ttl = media.error ? 60 : media.degraded ? 300 : parseInt(env.CACHE_TTL || DEFAULT_CACHE_TTL, 10);
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(media), {
        headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=" + ttl },
      })
    )
  );
  return media;
}

// Strategy 1: Instagram server-renders a complete media payload
// ("xig_polaris_media") for search-engine UAs, plus OG tags we keep as the
// last-resort fallback. One request, two outcomes.
async function fetchBotPage(code) {
  const res = await fetch(`https://www.instagram.com/p/${code}/`, {
    headers: { "User-Agent": CRAWLER_UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) return null;
  const html = await res.text();

  let media = null;
  const idx = html.indexOf('"xig_polaris_media":');
  if (idx !== -1) {
    const raw = extractBalancedJson(html, html.indexOf("{", idx));
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        const node = obj.if_not_gated_logged_out || (obj.media_type ? obj : null);
        if (node && (node.video_versions || node.image_versions2 || node.carousel_media)) {
          media = normalizeXig(node);
        }
      } catch (e) {}
    }
  }
  return { media, og: parseOgTags(html) };
}

function normalizeXig(node) {
  const first = (node.carousel_media && node.carousel_media[0]) || node;
  const user = node.user || node.owner || {};
  const pickVideo = (it) => it.video_versions && it.video_versions[0] && it.video_versions[0].url;
  const pickImage = (it) =>
    (it.image_versions2 && it.image_versions2.candidates && it.image_versions2.candidates[0] &&
      it.image_versions2.candidates[0].url) || it.display_uri || null;
  return {
    isVideo: !!pickVideo(first),
    videoUrl: pickVideo(first) || null,
    imageUrl: pickImage(first),
    username: user.username || null,
    fullName: user.full_name || null,
    profilePicUrl: user.profile_pic_url || null,
    caption: node.caption ? node.caption.text : null,
    takenAt: node.taken_at || null,
    width: first.original_width || null,
    height: first.original_height || null,
    itemCount: node.carousel_media ? node.carousel_media.length : 1,
    likes: node.like_count != null ? node.like_count : null,
    comments: node.comment_count != null ? node.comment_count : null,
    views: node.play_count ?? node.ig_play_count ?? node.view_count ?? null,
    children: node.carousel_media
      ? node.carousel_media.map((it) => ({
          isVideo: !!pickVideo(it),
          videoUrl: pickVideo(it) || null,
          imageUrl: pickImage(it),
        }))
      : null,
  };
}

// Strategy 2: GraphQL — rich data, but Instagram rotates the doc_id every few
// weeks. A synthetic csrftoken cookie/header pair is accepted (verified).
async function fromGraphql(code, env) {
  const docId = env.DOC_ID || DEFAULT_DOC_ID;
  const csrf = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const body = new URLSearchParams({
    av: "0", __d: "www", __user: "0", __a: "1", __comet_req: "7",
    lsd: "AVqbxe3J_YA",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "PolarisPostActionLoadPostQueryQuery",
    variables: JSON.stringify({
      shortcode: code,
      fetch_comment_count: 40, parent_comment_count: 24, child_comment_count: 3,
      fetch_like_count: 10, fetch_tagged_user_count: null, fetch_preview_comment_count: 2,
      has_threaded_comments: true, hoisted_comment_id: null, hoisted_reply_id: null,
    }),
    server_timestamps: "true",
    doc_id: docId,
  });

  const res = await fetch("https://www.instagram.com/graphql/query/", {
    method: "POST",
    headers: {
      "User-Agent": CHROME_UA,
      "Accept": "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": "csrftoken=" + csrf,
      "X-CSRFToken": csrf,
      "X-Ig-App-Id": IG_APP_ID,
      "X-Asbd-Id": "129477",
      "X-Fb-Friendly-Name": "PolarisPostActionLoadPostQueryQuery",
      "Origin": "https://www.instagram.com",
      "Referer": `https://www.instagram.com/p/${code}/`,
    },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const node = data && data.data && (data.data.xdt_shortcode_media || data.data.shortcode_media);
  return node ? normalizeGql(node) : null;
}

// OG tags from the crawler page: image, caption, and (inside og:url /
// og:description) the username. No video, but the username unlocks strategy 3
// and the image is the never-fails fallback.
function parseOgTags(html) {
  const og = (prop) => {
    const mm = html.match(new RegExp(`<meta property="og:${prop}" content="([^"]*)"`));
    return mm ? decodeHtml(mm[1]) : null;
  };
  const image = og("image");
  const desc = og("description") || "";
  const ogUrl = og("url") || "";

  // username: og:url is "https://www.instagram.com/<user>/reel/<code>/",
  // og:description is `123 likes, 4 comments - <user> on July 2, 2026: "..."`
  let username = null;
  let mm = ogUrl.match(/instagram\.com\/([A-Za-z0-9_.]+)\/(?:p|reel|reels|tv)\//);
  if (mm) username = mm[1];
  if (!username) {
    mm = desc.match(/-\s([A-Za-z0-9_.]+)\son\s/);
    if (mm) username = mm[1];
  }

  let caption = null;
  mm = desc.match(/on [A-Z][a-z]+ \d+, \d{4}: (?:&quot;|")([\s\S]*)$/);
  if (mm) caption = mm[1].replace(/(?:&quot;|")\.?\s*$/, "");

  let likes = null, comments = null;
  mm = desc.match(/^([\d,.KM]+) likes?, ([\d,.KM]+) comments?/);
  if (mm) { likes = mm[1]; comments = mm[2]; }

  if (!image && !username) return null;
  return {
    isVideo: false,
    imageUrl: image,
    username,
    caption: caption || desc,
    likesText: likes, commentsText: comments,
    width: null, height: null,
    degraded: true, // no video available via this path
  };
}

// Strategy 3: the web_profile_info API is stable, unauthenticated, and returns
// full video URLs for the account's recent posts.
async function fromProfileFeed(username, code) {
  const res = await fetch(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    { headers: { "User-Agent": CHROME_UA, "X-IG-App-ID": IG_APP_ID } }
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const user = data && data.data && data.data.user;
  const edges =
    user && user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges;
  if (!edges) return null;
  const edge = edges.find((e) => e.node && e.node.shortcode === code);
  if (!edge) return null;
  return normalizeGql({
    ...edge.node,
    owner: { username, full_name: user.full_name, profile_pic_url: user.profile_pic_url },
  });
}

// Strategy 4: the embed page inlines the GraphQL node as escaped JSON on some
// networks (this is InstaFix's primary method).
async function fromEmbedPage(code) {
  const res = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, {
    headers: { "User-Agent": CHROME_UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) return null;
  const html = await res.text();

  const gqlIdx = html.indexOf('\\"gql_data\\"');
  if (gqlIdx !== -1) {
    const raw = extractBalancedEscapedJson(html, gqlIdx);
    if (raw) {
      try {
        const gql = JSON.parse(JSON.parse('"' + raw + '"'));
        const node = gql.shortcode_media || gql.xdt_shortcode_media;
        if (node) return normalizeGql(node);
      } catch (e) {}
    }
  }

  const img = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/);
  const user = html.match(/class="UsernameText"[^>]*>([^<]+)</);
  if (img) {
    return {
      isVideo: false,
      imageUrl: decodeHtml(img[1]),
      username: user ? user[1] : null,
      caption: null, width: null, height: null,
    };
  }
  return null;
}

function normalizeGql(node) {
  // Carousel: use the first child as the embed medium
  let item = node;
  const children = node.edge_sidecar_to_children && node.edge_sidecar_to_children.edges;
  if (children && children.length) item = children[0].node;

  const captionEdges = node.edge_media_to_caption && node.edge_media_to_caption.edges;
  const likeCount =
    (node.edge_media_preview_like && node.edge_media_preview_like.count) ??
    (node.edge_liked_by && node.edge_liked_by.count);
  return {
    isVideo: !!item.is_video,
    videoUrl: item.video_url || null,
    imageUrl: item.display_url || node.display_url || node.thumbnail_src || null,
    username: node.owner ? node.owner.username : null,
    fullName: node.owner ? node.owner.full_name || null : null,
    profilePicUrl: node.owner ? node.owner.profile_pic_url || null : null,
    caption: captionEdges && captionEdges.length ? captionEdges[0].node.text : null,
    takenAt: node.taken_at_timestamp || null,
    width: item.dimensions ? item.dimensions.width : null,
    height: item.dimensions ? item.dimensions.height : null,
    itemCount: children ? children.length : 1,
    likes: likeCount != null ? likeCount : null,
    comments: node.edge_media_to_comment ? node.edge_media_to_comment.count : null,
    views: node.video_view_count ?? node.video_play_count ?? null,
    children: children
      ? children.map((e) => ({
          isVideo: !!e.node.is_video,
          videoUrl: e.node.video_url || null,
          imageUrl: e.node.display_url || null,
        }))
      : null,
  };
}

/* ---------------------------------- media proxy ---------------------------------- */

// Streams the actual bytes so the URL Discord caches never 403s from an expired
// CDN signature. Re-resolves on demand; Range requests are passed through.
async function proxyMedia(type, code, index, request, env, ctx) {
  const media = await resolveMedia(code, env, ctx);
  if (!media || media.error) return new Response("not found", { status: 404 });

  const item =
    media.children && media.children[index - 1] ? media.children[index - 1] : media;
  const target =
    type === "video" ? item.videoUrl || media.videoUrl :
    type === "pfp" ? media.profilePicUrl :
    item.imageUrl || media.imageUrl;
  if (!target) return new Response("no media", { status: 404 });

  const fwd = { "User-Agent": CHROME_UA };
  const range = request.headers.get("Range");
  if (range) fwd["Range"] = range;

  const upstream = await fetch(target, { headers: fwd });
  const headers = new Headers();
  for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Cache-Control", "public, max-age=1800");
  return new Response(upstream.body, { status: upstream.status, headers });
}

/* ---------------------------------- pages ---------------------------------- */

// The Discord path: a Mastodon-API-status-shaped JSON (what tnktok/fxTikTok
// serve). Discord renders it as a rich embed — account.avatar + display_name
// (@username) as the clickable author line, `content` (HTML; <b>/<br> become
// markdown) as the body, media_attachments as the inline video/images,
// created_at as the timestamp, application.name as the footer text.
async function apStatus(code, host, env, ctx) {
  const media = await resolveMedia(code, env, ctx);
  if (!media || media.error) return new Response("not found", { status: 404 });

  const igUrl = `https://www.instagram.com/p/${code}/`;
  const username = media.username || "instagram";

  const stats = [
    media.views != null ? `▶️ ${fmtCount(media.views)}` : null,
    media.likes != null ? `❤️ ${fmtCount(media.likes)}` : media.likesText ? `❤️ ${media.likesText}` : null,
    media.comments != null ? `💬 ${fmtCount(media.comments)}` : media.commentsText ? `💬 ${media.commentsText}` : null,
  ].filter(Boolean).join(" ");
  let content = media.caption ? linkify(htmlContent(truncate(media.caption, 500))) : "";
  if (stats) content += (content ? "<br><br>" : "") + `<b>${stats}</b>`;

  const items = media.children && media.children.length ? media.children : [media];
  const media_attachments = items.slice(0, 4).map((it, i) => {
    const idx = media.children ? `/${i + 1}` : "";
    const isVideo = !!(it.isVideo && (it.videoUrl || media.videoUrl));
    return {
      id: `${shortcodeToId(code) || code}-${i + 1}`,
      type: isVideo ? "video" : "image",
      url: `https://${host}/${isVideo ? "video" : "image"}/${code}${idx}`,
      preview_url: `https://${host}/image/${code}${idx}`,
      remote_url: null, preview_remote_url: null, text_url: null, description: null,
      meta: { original: { width: media.width || 720, height: media.height || 1280 } },
    };
  });

  const statusId = shortcodeToId(code) || code;
  const status = {
    id: statusId,
    url: igUrl,
    uri: igUrl,
    created_at: media.takenAt ? new Date(media.takenAt * 1000).toISOString() : "1970-01-01T00:00:00.000Z",
    content,
    spoiler_text: "",
    language: null,
    visibility: "public",
    application: { name: "igembed", website: `https://${host}` },
    media_attachments,
    account: {
      id: username,
      display_name: media.fullName || username,
      username,
      acct: username,
      url: `https://www.instagram.com/${username}/`,
      created_at: media.takenAt ? new Date(media.takenAt * 1000).toISOString() : "1970-01-01T00:00:00.000Z",
      locked: false, bot: false, discoverable: true, indexable: false, group: false,
      avatar: media.profilePicUrl ? `https://${host}/pfp/${code}` : null,
      avatar_static: media.profilePicUrl ? `https://${host}/pfp/${code}` : null,
      header: null, header_static: null,
      statuses_count: 0, hide_collections: false, noindex: false,
      emojis: [], roles: [], fields: [],
    },
    mentions: [], tags: [], emojis: [],
    card: null,
    poll: null,
  };

  return new Response(JSON.stringify(status), {
    headers: {
      "Content-Type": "application/activity+json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

// The HTML the crawlers fetch. Discord only uses the activity+json link above;
// the OG/twitter tags are the fallback for every other platform (and for
// Discord if the status fetch ever fails), shaped like tnktok's fallback:
// title = "Full Name (@username)", description = caption, player = the video.
function embedPage(media, code, igUrl, host) {
  const esc = escapeHtml;
  const username = media.username ? "@" + media.username : "instagram";
  const title =
    (media.fullName ? `${media.fullName} (${username})` : username) +
    (media.itemCount > 1 ? ` (1/${media.itemCount})` : "");
  const caption = media.caption ? truncate(media.caption, 220) : "";
  const profileUrl = media.username ? `https://www.instagram.com/${media.username}/` : "https://www.instagram.com";

  const tags = [
    `<meta charset="utf-8"/>`,
    `<meta property="og:site_name" content="igembed"/>`,
    `<meta property="og:url" content="${esc(igUrl)}"/>`,
    `<meta property="og:title" content="${esc(title)}"/>`,
    `<meta name="twitter:title" content="${esc(title)}"/>`,
    `<meta property="og:description" content="${esc(caption)}"/>`,
    `<meta name="theme-color" content="#E1306C"/>`,
    `<link rel="alternate" href="https://${host}/oembed.json?author=${encodeURIComponent(
      truncate(title, 250)
    )}&author_url=${encodeURIComponent(profileUrl)}&link=${encodeURIComponent(igUrl)}" type="application/json+oembed"/>`,
    `<link rel="alternate" type="application/activity+json" href="https://${host}/users/${encodeURIComponent(
      media.username || "instagram"
    )}/statuses/${shortcodeToId(code) || code}"/>`,
  ];

  if (media.isVideo && media.videoUrl) {
    const vurl = `https://${host}/video/${code}`;
    const w = media.width || 720, h = media.height || 1280;
    tags.push(
      `<meta property="og:type" content="video.other"/>`,
      `<meta property="og:video" content="${vurl}"/>`,
      `<meta property="og:video:secure_url" content="${vurl}"/>`,
      `<meta property="og:video:type" content="video/mp4"/>`,
      `<meta property="og:video:width" content="${w}"/>`,
      `<meta property="og:video:height" content="${h}"/>`,
      `<meta property="og:image" content="https://${host}/image/${code}"/>`,
      `<meta name="twitter:player:width" content="${w}"/>`,
      `<meta name="twitter:player:height" content="${h}"/>`,
      `<meta name="twitter:player:stream" content="${vurl}"/>`,
      `<meta name="twitter:player:stream:content_type" content="video/mp4"/>`
    );
  } else if (media.imageUrl) {
    // Degraded path: Instagram's own OG image URL is fresh, so link it directly
    const iurl = media.degraded ? media.imageUrl : `https://${host}/image/${code}`;
    tags.push(
      `<meta property="og:type" content="article"/>`,
      `<meta property="og:image" content="${esc(iurl)}"/>`,
      `<meta name="twitter:card" content="summary_large_image"/>`
    );
    if (media.width) tags.push(`<meta property="og:image:width" content="${media.width}"/>`);
    if (media.height) tags.push(`<meta property="og:image:height" content="${media.height}"/>`);
  }

  // No meta-refresh here: humans are 302'd server-side before this renders,
  // and a refresh tag can make crawlers treat the page as a redirect and skip
  // the activity+json link. Bots are the only audience for this HTML.
  const html = `<!DOCTYPE html><html><head>${tags.join("\n")}</head>
<body><a href="${esc(igUrl)}">View on Instagram</a></body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

function oembed(url) {
  const author = url.searchParams.get("author") || "Instagram";
  return new Response(
    JSON.stringify({
      version: "1.0",
      type: "link",
      author_name: author, // "Full Name (@username)", clickable -> profile
      author_url: url.searchParams.get("author_url") || "https://www.instagram.com",
      provider_name: "igembed",
      title: "Instagram post",
    }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } }
  );
}

function landingPage(host) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>igembed</title>
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:0 20px;line-height:1.6}code{background:#eee;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>igembed</h1>
<p>Fixes Instagram embeds in Discord. Replace <code>www.instagram.com</code> with <code>${host}</code> in any post or reel link:</p>
<p><code>https://${host}/reel/ABC123/</code></p>
<p>Crawlers get a proper video embed; everyone else is redirected straight to the post.</p>
<p>Add <code>/c</code> in front of the path (<code>https://${host}/c/reel/ABC123/</code>) for a clean embed: just the video or image, no caption or author text.</p>
</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

/* ---------------------------------- helpers ---------------------------------- */

async function resolveShareLink(path) {
  const res = await fetch("https://www.instagram.com" + path, {
    headers: { "User-Agent": CHROME_UA },
    redirect: "manual",
  });
  return res.headers.get("Location") || null;
}

// Extracts a balanced {...} JSON object starting exactly at `start`,
// string-aware so braces inside values don't break the depth count.
function extractBalancedJson(s, start) {
  if (start < 0 || s[start] !== "{") return null;
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Extracts the escaped-JSON object that starts at the first `{` after `from`,
// walking the string with \"-aware depth tracking. Returns the raw escaped text.
function extractBalancedEscapedJson(s, from) {
  const start = s.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    if (inStr) {
      if (s[i] === "\\" && s[i + 1] === "\\") i++;
      else if (s[i] === "\\" && s[i + 1] === '"') { inStr = false; i++; }
    } else if (s[i] === "\\" && s[i + 1] === '"') { inStr = true; i++; }
    else if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Instagram shortcodes are the numeric media ID in URL-safe base64. Discord
// only treats a /users/:u/statuses/:id link as a Mastodon status when the id
// looks Mastodon-like (numeric), so the AP URLs carry the decoded form.
const SC_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function shortcodeToId(code) {
  let n = 0n;
  for (const ch of code.slice(0, 11)) {
    const v = SC_ALPHA.indexOf(ch);
    if (v === -1) return null;
    n = n * 64n + BigInt(v);
  }
  return n.toString();
}

function idToShortcode(id) {
  let n = BigInt(id), s = "";
  while (n > 0n) {
    s = SC_ALPHA[Number(n % 64n)] + s;
    n /= 64n;
  }
  return s || "A";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/\n/g, " ");
}

// Like escapeHtml but keeps newlines as <br> — for the status `content` field.
function htmlContent(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/\n/g, "<br>");
}

// Turns @mentions and #hashtags in already-escaped caption HTML into links
// (Discord renders <a> in status content as markdown links). The lookbehinds
// keep emails and mid-word matches out; a mention can't end with a dot.
function linkify(s) {
  return s
    .replace(/(?<![\w.])@([A-Za-z0-9_.]*[A-Za-z0-9_])/g,
      '<a href="https://www.instagram.com/$1/">@$1</a>')
    .replace(/(?<![&\w])#([\p{L}\p{N}_]+)/gu,
      (_, t) => `<a href="https://www.instagram.com/explore/tags/${encodeURIComponent(t)}/">#${t}</a>`);
}

function decodeHtml(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
