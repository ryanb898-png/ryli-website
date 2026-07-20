/**
 * Anonymous usage ping — Cloudflare Pages Function.
 *
 * Accepts one POST per calendar day from an installed copy of RYLI (see
 * desktop/main.js's boot sequence, gated on app.isPackaged so dev/test runs
 * never count). Purely for rough usage visibility ("is anyone actually
 * using this, free or Pro") — RYLI otherwise has zero telemetry, by design.
 *
 * `id` is a random UUID generated once on first launch and stored in the
 * app's own settings.json (see settingsStore.js's `anon_usage_id`) — it is
 * NOT derived from and never travels with a license key, email, Whatnot
 * username, or anything else identifying. It exists only so repeat pings
 * from the same install can be told apart from a new install, which is
 * what makes "how many unique active installs" a meaningful number instead
 * of just "how many times has the app booted."
 *
 * KV layout (namespace binding: USAGE_KV):
 *   install:<id>              -> JSON { lastSeen: "YYYY-MM-DD", isPro, version }
 *   daily:<YYYY-MM-DD>:total  -> integer, unique installs seen that day
 *   daily:<YYYY-MM-DD>:pro    -> integer, unique Pro installs seen that day
 */
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  // Expects a UUID (crypto.randomUUID() client-side) — reject anything else
  // rather than let arbitrary strings become KV keys.
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    return new Response('bad request', { status: 400 });
  }
  const isPro = !!body.isPro;
  const version = typeof body.version === 'string' ? body.version.slice(0, 32) : 'unknown';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC

  const key = `install:${id}`;
  let existing = null;
  try {
    const raw = await env.USAGE_KV.get(key);
    existing = raw ? JSON.parse(raw) : null;
  } catch {
    existing = null;
  }
  const alreadyCountedToday = existing && existing.lastSeen === today;

  await env.USAGE_KV.put(key, JSON.stringify({ lastSeen: today, isPro, version }));

  // Only bump the daily aggregate the FIRST time this install is seen on a
  // given day — the app already throttles to one ping/day client-side, but
  // don't trust that alone (a retried/duplicate request must not double-count).
  if (!alreadyCountedToday) {
    const totalKey = `daily:${today}:total`;
    const proKey = `daily:${today}:pro`;
    const totalRaw = await env.USAGE_KV.get(totalKey);
    await env.USAGE_KV.put(totalKey, String(parseInt(totalRaw || '0', 10) + 1));
    if (isPro) {
      const proRaw = await env.USAGE_KV.get(proKey);
      await env.USAGE_KV.put(proKey, String(parseInt(proRaw || '0', 10) + 1));
    }
  }

  return new Response('ok', { status: 200 });
}
