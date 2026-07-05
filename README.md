# igembed

A lightweight Instagram embed fixer for Discord, running as a single-file
Cloudflare Worker. Replace `www.instagram.com` with your worker domain in any
post/reel link and Discord renders a tnktok/fxTikTok-style rich embed: the
author's profile picture and "Name (@username)" (clickable to the profile),
the caption, a bold ❤️/💬 stats line, the post's timestamp, and the video
playing inline. Anyone who clicks the link is 302-redirected straight to the
original Instagram post — no interstitial.

```
https://www.instagram.com/reel/ABC123/  ->  https://igembed.<you>.workers.dev/reel/ABC123/
```

## Deploy

```sh
npx wrangler login    # one-time browser login to your Cloudflare account
npx wrangler deploy
```

That's it — the deploy output prints your `*.workers.dev` URL. Test it by
pasting `https://<your-url>/reel/<some-reel-code>/` into Discord.

## Clean mode

Add `/c` in front of the path (or append `?c`) to embed just the media —
no caption, author, or stats, exactly like posting a bare video/image link:

```
https://igembed.<you>.workers.dev/c/reel/ABC123/
https://igembed.<you>.workers.dev/reel/ABC123/?c
```

## How it works

- **Discord** follows the page's `application/activity+json` alternate link to
  a Mastodon-status-shaped JSON (`/users/:user/statuses/:id`) and renders it as
  a rich fediverse embed — avatar, clickable author, caption body, stats,
  timestamp, footer. Discord verifies the status by re-fetching it through the
  canonical Mastodon REST path `/api/v1/statuses/:id` on the same host, so the
  worker serves both routes. The status id must be numeric: it's the shortcode
  base64-decoded to Instagram's media ID (losslessly convertible back).
- **Other crawlers** (Telegram, Slack, …, detected by User-Agent) use the
  `og:video` / `og:image` tags on the page itself, plus an oEmbed author line.
- **Everyone else** gets a 302 to the real post.
- **`/video/:code`, `/image/:code` and `/pfp/:code`** proxy the media bytes
  through the worker, re-resolving on demand, so Discord never caches an
  expired signed CDN URL (the "video shows up as an image" failure mode of
  other fixers).

Media data is resolved by trying, in order:

1. **GraphQL API** (`PolarisPostActionLoadPostQueryQuery`) — full data for any
   public post, including carousels. Instagram rotates the `doc_id` every few
   weeks; when it goes stale, update the `DOC_ID` var in `wrangler.toml` or the
   Cloudflare dashboard (Settings → Variables) — no redeploy of code needed.
   Find the current value in Instagram web's DevTools (Network → `graphql/query`
   → form field `doc_id` on a post page) or from the InstaFix repo.
2. **Crawler page → profile feed** — Instagram serves its own OG tags to
   crawler UAs (username, caption, thumbnail), and the unauthenticated
   `web_profile_info` API returns full video URLs for an account's ~12 most
   recent posts. Covers nearly every freshly-shared reel even with a dead doc_id.
3. **Embed page scrape** (`/embed/captioned/`) — inlined post JSON, works on
   some egress IPs.
4. **Instagram's own OG image + caption** — image-only, but never worse than a
   native Instagram embed.

Successful lookups are cached ~50 minutes (`CACHE_TTL` var to change).

## Supported URLs

- `/p/:code`, `/reel/:code`, `/reels/:code`, `/tv/:code`
- `/:username/p/:code`, `/:username/reel/:code`
- `/share/...` short links (resolved with one hop to Instagram)
- Anything else is forwarded to instagram.com unchanged.

## Notes

- Free plan limits: 100k requests/day — orders of magnitude more than a
  Discord server needs.
- A custom domain can be attached later in the Cloudflare dashboard
  (Workers → your worker → Domains & Routes) if you want something shorter
  than `workers.dev`.
- GitHub Pages (`inkitori.github.io`) can't do this: fixing embeds requires
  per-URL server-side meta tags, User-Agent detection, and live lookups
  against Instagram, none of which static hosting supports.
