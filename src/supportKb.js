// THE RYLI SUPPORT ASSISTANT'S KNOWLEDGE BASE — the single source of truth.
//
// The website chatbot (/api/support-chat) is told to answer ONLY from the text
// below. If the answer isn't here, it offers to pass the question to a human.
//
// TO UPDATE THE BOT'S ANSWERS: edit the prose between the backticks below, then
// redeploy the website (CLOUDFLARE_API_TOKEN=... npx wrangler deploy). Keep it
// plain, accurate, and in the second person. Do NOT use a backtick character
// inside the text (it would end the string early) — write code/URLs plainly.

export const SUPPORT_KB = `
# RYLI Support Knowledge Base

## What RYLI is
RYLI ("Run Your Live Intelligently") is a Windows desktop app that adds a live,
reactive overlay and an AI voice co-host to your live shows through OBS. It's
built for live sellers on Whatnot and for streamers. It reacts to your show in
real time — bids, sales, milestones, leaderboards — celebrates big moments on
screen, and can talk to your audience hands-free.

- It runs on Windows. There is no native Mac app yet, but it works on a Mac
  through Parallels (RYLI runs in the Windows VM; OBS runs on the Mac side).
- It works through OBS — RYLI's overlay is an OBS Browser Source. You need OBS
  installed.
- The overlay works on any platform OBS supports. The live data (bids, sales,
  leaderboards, Insights, Breaker Tools) is Whatnot-only today; Twitch support
  is what we're building next.
- RYLI runs on your Windows PC, not on a phone or tablet. You run your show from
  the computer; your viewers keep watching on their own phones/devices as usual.

## Pricing
- Free tier — genuinely free, no credit card. Includes the overlay, three base
  themes, milestone celebrations, camera framing, and more.
- RYLI Pro — 15.99 US dollars per month, with a 10-day free trial (no card
  needed to start). Pro unlocks: Ryli's AI voice co-host, premium themes and
  Ultra FX, the ticker rail, custom ad banners, Insights buyer boards, Breaker
  Tools, ThermalFlow label printing, and Stream Store downloads.
- You start the trial from inside the app; you activate Pro with a license key
  you get after subscribing.
- New subscribers get 20 percent off their first month.
- To download RYLI free, start the trial, or see plans and subscribe, go to
  ryliapp.com. The plans and the subscribe button are at
  https://ryli.app/pricing.
- Subscriptions are handled by Polar (our payment processor). You can cancel
  anytime from your Polar customer portal.

## Getting started / installing
1. Download RYLI from ryliapp.com (the Download button).
2. Run the installer (it's code-signed, so Windows should let it install
   cleanly).
3. Open RYLI and follow the onboarding wizard: activate your license (or start
   the trial), set up your mic/camera, connect OBS, open Whatnot, and pick a
   theme.
4. That's it — you go live from there.

## Connecting OBS
RYLI's overlay is an OBS Browser Source. The easiest way:
- In RYLI, go to Settings, then Connections, then OBS, and click "Connect and
  Add Overlay to OBS". RYLI connects to OBS's WebSocket and automatically
  creates a "RYLI Overlay" Browser Source pointed at the right URL.
- If you ever delete or move that source, the same button re-creates it.
- The overlay URL is http://127.0.0.1:8080/overlay.html if you ever need to add
  it by hand.
- Use a Browser Source, not Window Capture — it's a separate process and won't
  fight OBS for resources.
- Recommended OBS encoder for smooth playback: QuickSync H.264 (or your GPU's
  hardware encoder).

## Going live on Whatnot
- Click Go Live in RYLI. It opens a Chrome window to Whatnot. Start your show
  from your own Whatnot dashboard as usual — RYLI reads your show's live data
  from that browser.
- If Go Live doesn't open Chrome, Windows or antivirus may be blocking it. Try
  running RYLI as administrator, or check your antivirus / Windows Security
  "blocked apps" list for Chrome.
- RYLI only tracks your own show. If you watch or raid someone else's stream, it
  pauses tracking so their data never mixes into yours.

## Ryli — the AI voice co-host (Pro)
- Say "Hey Ryli" (or press your push-to-talk hotkey) and ask her questions about
  your show — top spender, sales so far, who's leading, etc. She answers out
  loud.
- Set her up in Settings, then Configure Ryli: mic, hotkey, voice, and
  optionally your own AI key (BYOK) for open-ended questions.
- She also announces break moments, shoutouts, and celebrations.

## Themes, overlay, and appearance
- Free tier includes three base themes; Pro unlocks premium colorways, Ultra FX,
  the ticker rail, custom ad banners, and your webcam in the jumbotron.
- Everything is in Settings, then Appearance and FX.
- FX quality (Lite / Balanced / Ultra) auto-detects from your hardware but is
  always adjustable.

## Breaker Tools (Pro) — for card breakers
Breaker Tools is a full breaking toolkit for Whatnot card breaks:
- A break board on your overlay showing every spot/team.
- League presets (NFL, NBA, MLB, NHL, and more) with team logos and colors.
- Pick Your Team, Random Team, and other formats.
- Mini-game signs (Stash or Pass, etc.) and a countdown that prompts buyers
  without cutting anyone off.
- Ryli calls the team out loud when a spot sells.
- A roster view grouped by buyer — every buyer and the teams they hold in one
  screen — which you can also print as a clean one-page sheet.
- Dashboard controls to assign, clear, and re-roll spots.
- Build from Whatnot syncs your board to a real Whatnot break.
Set it up in Settings, then Breaker Tools. It's a Pro feature and is off until
you switch it on.

## ThermalFlow (Pro) — label printing
ThermalFlow prints a shipping label the moment a lot is won, to a USB label
printer:
- Works two ways: any label printer with a Windows driver (DYMO, Zebra, Rollo,
  iDPRT, etc. — it just prints through Windows), and direct-USB printers that
  don't install as a normal printer.
- Set it up in Settings, then ThermalFlow: turn it on, pick your printer, choose
  a label size, and optionally add a logo and contact line.
- Label sizes include 1x1 inch, 2x1 inch, 1x3 inch, 2x3 inch (the default), and
  4x6 inch.
- If prints come out too dark/thick on a direct-USB printer, lower the "Print
  darkness" slider. There's also a "Text size" slider and a live preview that
  shows exactly how it will print.
- If a print fails with a data error, try a different USB cable first — a bad
  USB-C cable is a common cause. Then confirm the printer works in its own
  official app.
- It's off by default; it only prints when you turn it on.

## Insights
- The Insights page shows your lifetime and per-period performance: sales, top
  buyers, loyal regulars, records, and a trend chart.
- Buyer data comes from what RYLI tracks live during your own shows.

## Backups
- RYLI keeps local backups of your data automatically, and you can Export/Import
  from Settings, then About, then Data.
- Optional Google Drive backup (opt-in) backs up your show data to a private
  hidden folder in your own Google Drive. RYLI never sees that data — it goes
  straight from your computer to your Drive.

## Troubleshooting — common issues
- Overlay isn't showing in OBS: make sure the "RYLI Overlay" Browser Source
  exists (Settings, Connections, OBS, "Connect and Add Overlay"). Re-add it if
  it's missing.
- Ryli stopped responding / went quiet: this was fixed in a recent update; make
  sure you're on the latest version (RYLI auto-updates; you can also check
  Settings, About, Updates).
- A hotkey does nothing: on Windows, Ctrl+Alt+<letter> combos are treated as
  "AltGr" and often never fire. Use an F-key (like F2) instead — those are
  reliable.
- The board shows a number instead of tiles: this can happen if a spot's name is
  very long. Keep spot/team names short.
- My last week's numbers look off after an import: date-filtered views only
  include data RYLI tracked live from when you started using that feature.
- Update won't install / I'm behind: closing RYLI's window hides it to the tray
  (it keeps running). To fully apply an update, use the "Restart now" prompt, or
  quit from the tray and reopen.

## Multi-machine
RYLI is one license per machine. If you run RYLI on more than one computer, each
needs its own subscription/key. If you need a multi-machine setup, email us and
we'll help.

## Contact
If you can't get an answer here, leave your name, email, and a short message and
it goes to hello@ryliapp.com — the RYLI team replies from there. There's no
phone line; email is the way to reach a human.
`;
