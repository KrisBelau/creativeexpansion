<!-- GENERATED FILE — do not edit. Source: data/formats.json. Regenerate: node scripts/gen-catalog.mjs -->

# Format Catalog

Catalog version `2026.07.0` · updated 2026-07-29

Single source of truth for every output format the resizer supports. docs/FORMAT-CATALOG.md is generated from this file by scripts/gen-catalog.mjs — edit this file, never the markdown. Every placement carries verifiedOn + docs so drift is auditable; platform specs change without notice and any entry older than 90 days is surfaced as stale in the admin UI.

**Column meanings**

| Column | Meaning |
| --- | --- |
| Canvas | Render target at 1x. |
| Min | Smallest source resolution accepted without an upscale warning. |
| Safe zone | Inset in px from top / right / bottom / left of the canvas. No text, logo or CTA may enter this band. |
| Max size | Hard platform ceiling. The encoder targets 90% of it. |
| Duration | Accepted range, with the recommended window in brackets. |

## Platforms

- [Meta — Facebook & Instagram](#meta-facebook-instagram)
- [Google Display Network — Uploaded Display Ads (IAB)](#google-display-network-uploaded-display-ads-iab)
- [Google Ads — Responsive Asset Sets (RDA, Performance Max, Demand Gen)](#google-ads-responsive-asset-sets-rda-performance-max-demand-gen)
- [YouTube](#youtube)
- [TikTok](#tiktok)
- [Snapchat](#snapchat)
- [Pinterest](#pinterest)
- [LinkedIn](#linkedin)
- [X (Twitter)](#x-twitter)
- [Reddit](#reddit)
- [Amazon Ads](#amazon-ads)
- [CTV / OTT (DV360, Roku, Amazon, Hulu, Netflix Ads)](#ctv-ott-dv360-roku-amazon-hulu-netflix-ads)
- [Digital Audio (Spotify, Pandora, Podcasts)](#digital-audio-spotify-pandora-podcasts)
- [Microsoft Advertising](#microsoft-advertising)
- [DOOH / Place-Based](#dooh-place-based)
- [Email & Owned Channels](#email-owned-channels)

---

## Meta — Facebook & Instagram

Spec source: <https://www.facebook.com/business/ads-guide> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `meta_feed_square`<br>Feed — Square | image, video | 1:1 | 1080×1080 | 600×600 | none | 4 GB | 1–241s (rec 5–15s) | mobile |
| `meta_feed_portrait`<br>Feed — Portrait | image, video | 4:5 | 1080×1350 | 600×750 | none | 4 GB | 1–241s (rec 5–15s) | mobile |
| `meta_stories`<br>Stories | image, video | 9:16 | 1080×1920 | 500×889 | 250 / 60 / 340 / 60 | 4 GB | 1–120s (rec 5–15s) | mobile |
| `meta_reels`<br>Reels | video | 9:16 | 1080×1920 | 500×889 | 250 / 200 / 500 / 60 | 4 GB | 1–90s (rec 5–15s) | mobile |
| `meta_instream_video`<br>In-Stream Video | video | 16:9 | 1920×1080 | 1280×720 | 0 / 0 / 120 / 0 | 4 GB | 5–600s (rec 5–15s) | mobile |
| `meta_right_column`<br>Right Column | image | 1.91:1 | 1200×628 | 254×133 | none | 30 MB | — | display |
| `meta_carousel`<br>Carousel Card | image, video | 1:1 | 1080×1080 | 600×600 | none | 4 GB | 1–240s (rec 5–15s) | mobile |

**Notes**

- **Feed — Square**
  - Highest-volume placement; treat as the primary master when the brief does not say otherwise.
  - Feed crops nothing, but the caption block sits below — do not duplicate caption copy in-image.
- **Feed — Portrait**
  - Tallest ratio the feed will render without centre-cropping; wins the most screen height on mobile.
- **Stories**
  - Profile row and progress bar occupy the top band; the CTA sticker and 'Sponsored' label occupy the bottom band.
  - Background must reach all four edges — the platform does not letterbox, it stretches or bars.
- **Reels**
  - Most aggressive chrome of any placement: caption, profile, audio ticker and CTA all overlay the frame.
  - The right-edge inset covers the like/comment/share rail — a logo lockup placed bottom-right will be obscured.
- **In-Stream Video**
  - Skip control and countdown sit in the lower band. Sound-on placement — mix for audible playback.
- **Right Column**
  - Renders as small as 254px wide. Any type below the display legibility floor must be dropped, not shrunk.
- **Carousel Card**
  - All cards in a set must share ratio and canvas; the batch validator enforces set consistency.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Feed — Square | aac | 128 kbps | -14 LUFS |
| Feed — Portrait | aac | 128 kbps | -14 LUFS |
| Stories | aac | 128 kbps | -14 LUFS |
| Reels | aac | 128 kbps | -14 LUFS |
| In-Stream Video | aac | 128 kbps | -14 LUFS |
| Carousel Card | aac | 128 kbps | -14 LUFS |

---

## Google Display Network — Uploaded Display Ads (IAB)

Spec source: <https://support.google.com/google-ads/answer/1722096> · verified 2026-07-29

**Applies to every size below:**

- Image: max 150 KB, encodings jpg / png / gif
- Animation: max 30s, 3 loops, 5 fps ceiling
- 150 KB ceiling applies to every size including animated GIF and HTML5 bundles.
- Border required: ads on a white background need a visible 1px frame.

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Context |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gdn_300x250`<br>Medium Rectangle | image | — | 300×250 | — | — | 150 KB | display |
| `gdn_336x280`<br>Large Rectangle | image | — | 336×280 | — | — | 150 KB | display |
| `gdn_728x90`<br>Leaderboard | image | — | 728×90 | — | — | 150 KB | display |
| `gdn_970x90`<br>Large Leaderboard | image | — | 970×90 | — | — | 150 KB | display |
| `gdn_970x250`<br>Billboard | image | — | 970×250 | — | — | 150 KB | display |
| `gdn_300x600`<br>Half-Page | image | — | 300×600 | — | — | 150 KB | display |
| `gdn_300x1050`<br>Portrait | image | — | 300×1050 | — | — | 150 KB | display |
| `gdn_160x600`<br>Wide Skyscraper | image | — | 160×600 | — | — | 150 KB | display |
| `gdn_120x600`<br>Skyscraper | image | — | 120×600 | — | — | 150 KB | display |
| `gdn_468x60`<br>Banner | image | — | 468×60 | — | — | 150 KB | display |
| `gdn_234x60`<br>Half Banner | image | — | 234×60 | — | — | 150 KB | display |
| `gdn_250x250`<br>Square | image | — | 250×250 | — | — | 150 KB | display |
| `gdn_200x200`<br>Small Square | image | — | 200×200 | — | — | 150 KB | display |
| `gdn_180x150`<br>Small Rectangle | image | — | 180×150 | — | — | 150 KB | display |
| `gdn_125x125`<br>Button | image | — | 125×125 | — | — | 150 KB | display |
| `gdn_240x400`<br>Vertical Rectangle | image | — | 240×400 | — | — | 150 KB | display |
| `gdn_250x360`<br>Triple Widescreen | image | — | 250×360 | — | — | 150 KB | display |
| `gdn_580x400`<br>Netboard | image | — | 580×400 | — | — | 150 KB | display |
| `gdn_930x180`<br>Top Banner | image | — | 930×180 | — | — | 150 KB | display |
| `gdn_980x120`<br>Panorama | image | — | 980×120 | — | — | 150 KB | display |
| `gdn_320x50`<br>Mobile Leaderboard | image | — | 320×50 | — | — | 150 KB | display |
| `gdn_320x100`<br>Large Mobile Banner | image | — | 320×100 | — | — | 150 KB | display |
| `gdn_300x50`<br>Mobile Banner | image | — | 300×50 | — | — | 150 KB | display |
| `gdn_320x480`<br>Mobile Interstitial — Portrait | image | — | 320×480 | — | — | 150 KB | display |
| `gdn_480x320`<br>Mobile Interstitial — Landscape | image | — | 480×320 | — | — | 150 KB | display |
| `gdn_768x1024`<br>Tablet Interstitial — Portrait | image | — | 768×1024 | — | — | 150 KB | display |
| `gdn_1024x768`<br>Tablet Interstitial — Landscape | image | — | 1024×768 | — | — | 150 KB | display |

**Notes**

- **Medium Rectangle**
  - Highest-inventory display size.
- **Leaderboard**
  - Headline-only size; body copy is dropped by the type rules.
- **Button**
  - Logo-only size — the layout solver drops all copy.
- **Mobile Leaderboard**
  - Smallest supported canvas; logo + 1 short headline only.

---

## Google Ads — Responsive Asset Sets (RDA, Performance Max, Demand Gen)

Spec source: <https://support.google.com/google-ads/answer/7331111> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `goog_asset_landscape`<br>Marketing Image — Landscape | image | 1.91:1 | 1200×628 | 600×314 | — | 5 MB | — | mobile |
| `goog_asset_square`<br>Marketing Image — Square | image | 1:1 | 1200×1200 | 300×300 | — | 5 MB | — | mobile |
| `goog_asset_portrait`<br>Marketing Image — Portrait | image | 4:5 | 960×1200 | 480×600 | — | 5 MB | — | mobile |
| `goog_asset_logo_square`<br>Logo — Square | image | 1:1 | 1200×1200 | 128×128 | — | 5 MB | — | mobile |
| `goog_asset_logo_landscape`<br>Logo — Landscape | image | 4:1 | 1200×300 | 512×128 | — | 5 MB | — | mobile |
| `goog_asset_video_landscape`<br>Video — Landscape | video | 16:9 | 1920×1080 | — | — | — | 6–180s (rec 10–30s) | mobile |
| `goog_asset_video_square`<br>Video — Square | video | 1:1 | 1080×1080 | — | — | — | 6–180s (rec 10–30s) | mobile |
| `goog_asset_video_vertical`<br>Video — Vertical | video | 9:16 | 1080×1920 | — | 200 / 60 / 400 / 60 | — | 6–180s (rec 10–30s) | mobile |

**Notes**

- **Marketing Image — Landscape**
  - Required asset. Google crops up to 5% from each edge on some surfaces — keep a 5% content inset.
- **Marketing Image — Square**
  - Required asset.
- **Logo — Square**
  - Transparent PNG preferred. Rendered circular on some surfaces — keep the mark inside an inscribed circle.
- **Video — Vertical**
  - Serves into Shorts and Discover — same chrome problem as Reels.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Video — Landscape | aac | 128 kbps | -14 LUFS |
| Video — Square | aac | 128 kbps | -14 LUFS |
| Video — Vertical | aac | 128 kbps | -14 LUFS |

---

## YouTube

Spec source: <https://support.google.com/google-ads/answer/2375464> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yt_instream`<br>In-Stream (skippable & non-skippable) | video | 16:9 | 1920×1080 | — | 0 / 0 / 140 / 0 | — | 6–180s (rec 15–30s) | mobile |
| `yt_bumper`<br>Bumper | video | 16:9 | 1920×1080 | — | — | — | 1–6s (rec 6–6s) | mobile |
| `yt_shorts`<br>Shorts | video | 9:16 | 1080×1920 | — | 200 / 200 / 480 / 60 | — | 1–60s (rec 10–30s) | mobile |
| `yt_companion`<br>Display Companion Banner | image | — | 300×60 | — | — | 150 KB | — | display |
| `yt_masthead`<br>Masthead | video | 16:9 | 1920×1080 | — | — | — | 5–30s (rec 15–30s) | mobile |

**Notes**

- **In-Stream (skippable & non-skippable)**
  - Non-skippable capped at 15–20s by market. Skip button and progress bar sit in the lower band.
- **Bumper**
  - 6s hard cap — the duration adapter must land a legible end-card inside 6s.
- **Masthead**
  - Autoplays muted — must read without sound.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| In-Stream (skippable & non-skippable) | aac | 128 kbps | -14 LUFS |
| Bumper | aac | 128 kbps | -14 LUFS |
| Shorts | aac | 128 kbps | -14 LUFS |
| Masthead | aac | 128 kbps | -14 LUFS |

---

## TikTok

Spec source: <https://ads.tiktok.com/help/article/tiktok-ads-specifications> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tiktok_infeed_vertical`<br>In-Feed — Vertical | video | 9:16 | 1080×1920 | — | 130 / 140 / 484 / 64 | 500 MB | 5–60s (rec 9–15s) | mobile |
| `tiktok_infeed_square`<br>In-Feed — Square | video | 1:1 | 1080×1080 | — | — | 500 MB | 5–60s (rec 9–15s) | mobile |
| `tiktok_infeed_landscape`<br>In-Feed — Landscape | video | 16:9 | 1920×1080 | — | — | 500 MB | 5–60s (rec 9–15s) | mobile |
| `tiktok_pangle`<br>Pangle Network | video, image | 9:16 | 1080×1920 | — | — | 500 MB | 5–60s (rec 9–15s) | mobile |
| `tiktok_brand_logo`<br>Brand Logo | image | 1:1 | 200×200 | — | — | 500 KB | — | display |

**Notes**

- **In-Feed — Vertical**
  - The published safe area is the tightest in market — the bottom band carries the caption, handle, music ticker and CTA.
  - Sound-on by default; captions still required for comprehension.
- **In-Feed — Landscape**
  - Pillarboxed in a vertical feed — deprioritise unless the buy is Pangle.
- **Brand Logo**
  - Rendered circular — keep the mark inside an inscribed circle.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| In-Feed — Vertical | aac | 128 kbps | -14 LUFS |
| In-Feed — Square | aac | 128 kbps | -14 LUFS |
| In-Feed — Landscape | aac | 128 kbps | -14 LUFS |
| Pangle Network | aac | 128 kbps | -14 LUFS |

---

## Snapchat

Spec source: <https://businesshelp.snapchat.com/s/article/ads-specs> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `snap_single`<br>Single Image or Video Ad | image, video | 9:16 | 1080×1920 | — | 150 / 64 / 450 / 64 | 32 MB | 3–180s (rec 3–5s) | mobile |
| `snap_collection`<br>Collection Ad Product Tile | image | 1:1 | 1080×1080 | — | — | 32 MB | — | mobile |

**Notes**

- **Single Image or Video Ad**
  - 32 MB ceiling on video is the binding constraint — the encoder drops to a lower bitrate ladder rung here.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Single Image or Video Ad | aac | 128 kbps | -14 LUFS |

---

## Pinterest

Spec source: <https://help.pinterest.com/en/business/article/pinterest-product-specs> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pin_standard_2x3`<br>Standard Pin | image | 2:3 | 1000×1500 | — | — | 20 MB | — | mobile |
| `pin_square`<br>Square Pin | image | 1:1 | 1000×1000 | — | — | 20 MB | — | mobile |
| `pin_video_2x3`<br>Standard Video Pin | video | 2:3 | 1000×1500 | — | — | 2 GB | 4–900s (rec 6–15s) | mobile |
| `pin_video_maxwidth`<br>Max-Width Video Pin | video | 1:1 | 1080×1080 | — | — | 2 GB | 4–900s (rec 6–15s) | mobile |
| `pin_idea`<br>Idea Pin Page | image, video | 9:16 | 1080×1920 | — | 180 / 64 / 340 / 64 | 2 GB | 3–60s (rec 6–15s) | mobile |

**Notes**

- **Standard Pin**
  - 2:3 is the only ratio the feed renders uncropped at full height.
- **Max-Width Video Pin**
  - Spans the full feed width with copy rendered below — no in-image caption needed.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Standard Video Pin | aac | 128 kbps | -14 LUFS |
| Max-Width Video Pin | aac | 128 kbps | -14 LUFS |
| Idea Pin Page | aac | 128 kbps | -14 LUFS |

---

## LinkedIn

Spec source: <https://www.linkedin.com/help/lms/answer/a424483> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `li_single_landscape`<br>Single Image — Landscape | image | 1.91:1 | 1200×628 | — | — | 5 MB | — | mobile |
| `li_single_square`<br>Single Image — Square | image | 1:1 | 1200×1200 | — | — | 5 MB | — | mobile |
| `li_single_portrait`<br>Single Image — Portrait | image | 4:5 | 1200×1500 | — | — | 5 MB | — | mobile |
| `li_carousel`<br>Carousel Card | image | 1:1 | 1080×1080 | — | — | 10 MB | — | mobile |
| `li_video_landscape`<br>Video — Landscape | video | 16:9 | 1920×1080 | — | — | 200 MB | 3–1800s (rec 15–30s) | mobile |
| `li_video_square`<br>Video — Square | video | 1:1 | 1080×1080 | — | — | 200 MB | 3–1800s (rec 15–30s) | mobile |
| `li_video_vertical`<br>Video — Vertical | video | 9:16 | 1080×1920 | — | 160 / 64 / 300 / 64 | 200 MB | 3–1800s (rec 15–30s) | mobile |
| `li_spotlight_logo`<br>Spotlight / Text Ad Logo | image | 1:1 | 300×300 | — | — | 2 MB | — | display |

**Notes**

- **Single Image — Portrait**
  - Mobile-only surface.
- **Video — Landscape**
  - Minimum file size 75 KB — the encoder floor prevents over-compression on flat graphics.
- **Spotlight / Text Ad Logo**
  - Also served at 100x100 and 50x50 — logo-only, no type.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Video — Landscape | aac | 128 kbps | -14 LUFS |
| Video — Square | aac | 128 kbps | -14 LUFS |
| Video — Vertical | aac | 128 kbps | -14 LUFS |

---

## X (Twitter)

Spec source: <https://business.x.com/en/help/campaign-setup/advertiser-card-specifications.html> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `x_image_landscape`<br>Image — Landscape | image | 16:9 | 1600×900 | — | — | 5 MB | — | mobile |
| `x_image_square`<br>Image — Square | image | 1:1 | 1200×1200 | — | — | 5 MB | — | mobile |
| `x_image_portrait`<br>Image — Portrait | image | 4:5 | 1200×1500 | — | — | 5 MB | — | mobile |
| `x_video_landscape`<br>Video — Landscape | video | 16:9 | 1920×1080 | — | — | 512 MB | 1–140s (rec 6–15s) | mobile |
| `x_video_square`<br>Video — Square | video | 1:1 | 1080×1080 | — | — | 512 MB | 1–140s (rec 6–15s) | mobile |
| `x_video_vertical`<br>Video — Vertical | video | 9:16 | 1080×1920 | — | 120 / 64 / 300 / 64 | 512 MB | 1–140s (rec 6–15s) | mobile |

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Video — Landscape | aac | 128 kbps | -14 LUFS |
| Video — Square | aac | 128 kbps | -14 LUFS |
| Video — Vertical | aac | 128 kbps | -14 LUFS |

---

## Reddit

Spec source: <https://business.reddithelp.com/helpcenter/s/article/Ad-formats-and-specs> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reddit_image_landscape`<br>Image — Landscape | image | 1.91:1 | 1200×628 | — | — | 20 MB | — | mobile |
| `reddit_image_square`<br>Image — Square | image | 1:1 | 1080×1080 | — | — | 20 MB | — | mobile |
| `reddit_video_square`<br>Video — Square | video | 1:1 | 1080×1080 | — | — | 1 GB | 1–900s (rec 10–30s) | mobile |
| `reddit_video_vertical`<br>Video — Vertical | video | 9:16 | 1080×1920 | — | 140 / 64 / 320 / 64 | 1 GB | 1–900s (rec 10–30s) | mobile |

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Video — Square | aac | 128 kbps | -14 LUFS |
| Video — Vertical | aac | 128 kbps | -14 LUFS |

---

## Amazon Ads

Spec source: <https://advertising.amazon.com/resources/ad-specs> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `amz_sd_custom_image`<br>Sponsored Display — Custom Image | image | 1.91:1 | 1200×628 | 640×336 | — | 5 MB | — | mobile |
| `amz_sb_brand_logo`<br>Brand Logo | image | 1:1 | 400×400 | — | — | 1 MB | — | display |
| `amz_sb_video`<br>Sponsored Brands Video | video | 16:9 | 1920×1080 | — | — | 500 MB | 6–45s (rec 15–30s) | mobile |
| `amz_dsp_300x250`<br>DSP Display — Medium Rectangle | image | — | 300×250 | — | — | 200 KB | — | display |
| `amz_dsp_728x90`<br>DSP Display — Leaderboard | image | — | 728×90 | — | — | 200 KB | — | display |
| `amz_dsp_160x600`<br>DSP Display — Wide Skyscraper | image | — | 160×600 | — | — | 200 KB | — | display |
| `amz_dsp_300x600`<br>DSP Display — Half-Page | image | — | 300×600 | — | — | 200 KB | — | display |
| `amz_dsp_970x250`<br>DSP Display — Billboard | image | — | 970×250 | — | — | 200 KB | — | display |
| `amz_dsp_320x50`<br>DSP Display — Mobile Leaderboard | image | — | 320×50 | — | — | 200 KB | — | display |

**Notes**

- **Sponsored Display — Custom Image**
  - No text, logos, or CTAs permitted in the custom image — the validator hard-fails any detected type.
- **Sponsored Brands Video**
  - Audio target is quieter than social; -19 LUFS integrated, true peak -2 dBTP.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Sponsored Brands Video | aac | 192 kbps | -19 LUFS |

---

## CTV / OTT (DV360, Roku, Amazon, Hulu, Netflix Ads)

Spec source: <https://iabtechlab.com/standards/digital-video-ad-format-guidelines/> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ctv_1080p`<br>CTV — 1080p | video | 16:9 | 1920×1080 | — | 54 / 96 / 54 / 96 | 1 GB | 15–60s (rec 15–30s) | ctv |
| `ctv_4k`<br>CTV — 4K | video | 16:9 | 3840×2160 | — | 108 / 192 / 108 / 192 | 4 GB | 15–60s (rec 15–30s) | ctv |

**Notes**

- **CTV — 1080p**
  - Title-safe inset follows broadcast convention (5% of each edge) — living-room viewing distance and TV overscan both bite.
  - Loudness is broadcast spec (-24 LKFS ±2, true peak -2 dBTP), roughly 10 dB quieter than social.
  - Minimum legible type is far larger than mobile: 2% of frame height.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| CTV — 1080p | aac | 192 kbps | -24 LUFS |
| CTV — 4K | aac | 192 kbps | -24 LUFS |

---

## Digital Audio (Spotify, Pandora, Podcasts)

Spec source: <https://ads.spotify.com/en-US/ad-specs/> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `spotify_companion`<br>Audio Companion Banner | image | 1:1 | 640×640 | — | — | 200 KB | — | display |
| `spotify_video_takeover`<br>Video Takeover | video | 16:9 | 1920×1080 | — | — | 500 MB | 15–30s (rec 15–30s) | mobile |

**Notes**

- **Audio Companion Banner**
  - Rendered as small as 300x300 — logo plus one short line.

**Audio targets**

| Placement | Codec | Min bitrate | Loudness |
| --- | --- | --- | --- |
| Video Takeover | aac | 192 kbps | -16 LUFS |

---

## Microsoft Advertising

Spec source: <https://help.ads.microsoft.com/apex/index/3/en/56900> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Context |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `msft_audience_landscape`<br>Audience Ad — Landscape | image | 1.91:1 | 1200×628 | — | — | 3 MB | mobile |
| `msft_audience_square`<br>Audience Ad — Square | image | 1:1 | 1200×1200 | — | — | 3 MB | mobile |
| `msft_audience_4x1`<br>Audience Ad — 4:1 | image | 4:1 | 1200×300 | — | — | 3 MB | mobile |
| `msft_audience_portrait`<br>Audience Ad — Portrait | image | 4:5 | 960×1200 | — | — | 3 MB | mobile |

---

## DOOH / Place-Based

Spec source: <https://iabtechlab.com/standards/digital-out-of-home/> · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration | Context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dooh_portrait_1080`<br>Urban Panel — Portrait | image, video | 9:16 | 1080×1920 | — | 96 / 54 / 96 / 54 | 256 MB | 8–15s (rec 10–10s) | dooh |
| `dooh_landscape_1920`<br>Screen — Landscape 1080p | image, video | 16:9 | 1920×1080 | — | 54 / 96 / 54 / 96 | 256 MB | 8–15s (rec 10–10s) | dooh |
| `dooh_billboard_2x1`<br>Digital Billboard — 2:1 | image | 2:1 | 2880×1440 | — | — | 20 MB | — | billboard |

**Notes**

- **Urban Panel — Portrait**
  - Viewed at 2–5 m: minimum type is 3% of frame height, and no more than 7 words on screen at once.
- **Digital Billboard — 2:1**
  - Viewed at 30 m+: headline only, minimum type 6% of frame height.

---

## Email & Owned Channels

Spec source: _internal convention_ · verified 2026-07-29

| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Context |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `email_hero`<br>Email Hero (2x retina) | image | 1.91:1 | 1200×628 | — | — | 500 KB | email |
| `email_module_square`<br>Email Module — Square | image | 1:1 | 1200×1200 | — | — | 500 KB | email |
| `web_og_image`<br>Open Graph / Social Share | image | 1.91:1 | 1200×630 | — | — | 5 MB | display |

**Notes**

- **Email Hero (2x retina)**
  - Renders at 600 CSS px — legibility is computed against the 600px display width, not the 1200px canvas.

---

**Total: 100 placements across 16 platforms.**
