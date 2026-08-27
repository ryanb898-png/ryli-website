// RYLI marketing site — vanilla JS, no build step, no framework.

// Read once and honoured everywhere below: stagger delays are skipped, and the
// carousel never starts autoplaying. Nothing on this site used to check it.
const REDUCED = window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Anonymous pageview beacon — one fire-and-forget call per real page load.
// Loaded on every HTML page in this site (index/privacy/terms/setup-guide/
// thank-you), so this covers the whole site from one place. Counts raw
// pageviews only: no cookie, no fingerprint, no visitor id is ever created
// or read, no third-party analytics service — matching the same "anonymous,
// aggregate only" stance already documented for the desktop app's own usage
// ping (see /api/ping in the Worker). keepalive:true so the request isn't
// dropped if the tab closes/navigates away before it completes; a failure
// here must never be visible or block the page in any way.
try {
  fetch('/api/visit', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    // Two aggregate fields, both reduced server-side before anything is
    // stored: the referrer is cut down to a bare hostname (never the full
    // URL, which could carry a search query), and the path is stored without
    // its query string. Still no cookie, no id, nothing linking one visit to
    // the next -- this answers "where did people come from and what did they
    // open", which the region counter alone cannot.
    body: JSON.stringify({ referrer: document.referrer || '', path: location.pathname || '/' }),
  }).catch(() => {});
} catch {}

// Download intent. Visits and installs were the only two numbers here, which
// makes "hundreds of visits, a handful of installs" impossible to read -- a
// traffic problem and a page problem look identical. This is the step between
// them. Fires on any link to the installer, wherever it appears on the site,
// and never delays or blocks the download itself.
try {
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href*="releases/latest/download"]');
    if (!a) return;
    try { fetch('/api/download-click', { method: 'POST', keepalive: true }).catch(() => {}); } catch {}
  }, { capture: true });
} catch {}

// Mobile nav toggle
const nav = document.querySelector('.nav');
const navToggle = document.querySelector('.nav__toggle');
if (nav && navToggle) {
  navToggle.addEventListener('click', () => nav.classList.toggle('is-open'));
  nav.querySelectorAll('.nav__links a').forEach((link) => {
    link.addEventListener('click', () => nav.classList.remove('is-open'));
  });
}

// Carousels — native scroll-snap for touch swipe, JS only drives the
// dots/arrows and keeps the active dot in sync with manual swiping.
document.querySelectorAll('[data-carousel]').forEach((carousel) => {
  const track = carousel.querySelector('.carousel__track');
  const slides = Array.from(track.children);
  const dotsWrap = carousel.querySelector('.carousel__dots');
  const prevBtn = carousel.querySelector('.carousel__arrow--prev');
  const nextBtn = carousel.querySelector('.carousel__arrow--next');

  if (slides.length <= 1) {
    carousel.setAttribute('data-single', '');
    return;
  }

  // SCROLL THE TRACK, NOT THE PAGE.
  //
  // This used to call slide.scrollIntoView(), and scrollIntoView walks UP the
  // tree scrolling every scrollable ancestor it finds -- including the document.
  // block:'nearest' reduces that but does not prevent it, and iOS Safari is
  // especially eager. The symptom was reported from a real phone: scrolling the
  // page vertically would periodically snap back to the carousel, because an
  // autoplay tick fired mid-scroll and the browser obligingly moved the PAGE to
  // bring the next slide into view.
  //
  // scrollTo on the track itself cannot move anything but the track.
  function scrollTrackTo(slide) {
    track.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' });
  }

  const dots = slides.map((_, i) => {
    const dot = document.createElement('button');
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.addEventListener('click', () => {
      scrollTrackTo(slides[i]);
    });
    dotsWrap.appendChild(dot);
    return dot;
  });

  function setActive(index) {
    dots.forEach((d, i) => d.classList.toggle('is-active', i === index));
  }
  setActive(0);

  function currentIndex() {
    const scrollLeft = track.scrollLeft;
    let closest = 0;
    let closestDist = Infinity;
    slides.forEach((slide, i) => {
      const dist = Math.abs(slide.offsetLeft - scrollLeft);
      if (dist < closestDist) { closestDist = dist; closest = i; }
    });
    return closest;
  }

  function goTo(idx) {
    const clamped = Math.max(0, Math.min(slides.length - 1, idx));
    scrollTrackTo(slides[clamped]);
  }

  let scrollTimeout;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => setActive(currentIndex()), 80);
  });

  prevBtn.addEventListener('click', () => { goTo(currentIndex() - 1); restartAutoplay(); });
  nextBtn.addEventListener('click', () => { goTo(currentIndex() + 1); restartAutoplay(); });
  dots.forEach((dot) => dot.addEventListener('click', restartAutoplay));

  // Auto-advance — loops forever, but any manual interaction (arrow, dot,
  // or a real touch swipe on the track) resets the timer so it never fights
  // the user mid-browse. Pauses while the tab/section isn't visible.
  const autoplayMs = Number(carousel.dataset.autoplay);
  let autoplayTimer = null;
  function tickAutoplay() {
    const next = currentIndex() + 1 >= slides.length ? 0 : currentIndex() + 1;
    goTo(next);
  }
  function startAutoplay() {
    if (!autoplayMs || autoplayTimer) return;
    autoplayTimer = setInterval(tickAutoplay, autoplayMs);
  }
  function stopAutoplay() {
    clearInterval(autoplayTimer);
    autoplayTimer = null;
  }
  function restartAutoplay() { stopAutoplay(); startAutoplay(); }

  if (autoplayMs && !REDUCED) {
    let userInteracting = false;
    let paused = false;

    // A REAL pause control. Autoplay that loops forever with only a hover
    // escape is continuous motion a keyboard or touch user cannot stop, which
    // is a genuine accessibility failure rather than a nicety.
    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = 'carousel__pause';
    const paint = () => {
      pauseBtn.textContent = paused ? '▶' : '‖';
      pauseBtn.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
      pauseBtn.setAttribute('aria-pressed', String(paused));
    };
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      if (paused) stopAutoplay(); else startAutoplay();
      paint();
    });
    paint();
    if (dotsWrap) dotsWrap.appendChild(pauseBtn);

    // Tabbing onto an arrow used to have the slide yanked out from under you.
    carousel.addEventListener('focusin', stopAutoplay);
    carousel.addEventListener('focusout', () => { if (!paused && !userInteracting) startAutoplay(); });
    // The old comment claimed this already happened. Only the section half did.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopAutoplay(); else if (!paused) startAutoplay();
    });
    track.addEventListener('pointerdown', () => { userInteracting = true; stopAutoplay(); });
    track.addEventListener('pointerup', () => { userInteracting = false; if (!paused) restartAutoplay(); });
    carousel.addEventListener('mouseenter', stopAutoplay);
    carousel.addEventListener('mouseleave', () => { if (!userInteracting && !paused) startAutoplay(); });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        entries.forEach((entry) => ((entry.isIntersecting && !paused) ? startAutoplay() : stopAutoplay()));
      }, { threshold: 0.3 }).observe(carousel);
    } else {
      startAutoplay();
    }
  }
});

// Showcase toggles (Hype Meter / Companion, and Stream Store / Themes & FX)
document.querySelectorAll('.showcase-toggle__btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.showPanel;
    // Scope to the owning section. This was a global query, which worked only
    // while exactly one showcase existed on the page — with two, clicking a tab
    // in one would deactivate the other's tabs and blank its panel.
    const scope = btn.closest('section') || document;
    scope.querySelectorAll('.showcase-toggle__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    scope.querySelectorAll('.showcase-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === target));
  });
});

// Per-child stagger delays, read by the .stagger rule in styles.css. Capped at
// 7 so an eleven-item pricing list does not take two seconds to arrive.
document.querySelectorAll('.stagger').forEach((group) => {
  Array.from(group.children).forEach((el, i) => {
    el.style.setProperty('--d', REDUCED ? '0s' : (Math.min(i, 7) * 0.07) + 's');
  });
});

// The Hype Meter runs itself once, when it is first seen. The bar and the
// countdown are pure CSS off an .is-live class; only the participation count
// needs JS, because it is a number being tallied rather than a property being
// tweened. Reduced motion gets the finished state with no animation at all.
document.querySelectorAll('.hype-media').forEach((media) => {
  const count = media.querySelector('.hm-count');
  const to = count ? Number(count.dataset.to) || 0 : 0;
  const settle = () => { if (count) count.textContent = to + ' joining in'; };

  if (REDUCED || !('IntersectionObserver' in window)) {
    media.classList.add('is-live');
    settle();
    return;
  }

  const run = () => {
    media.classList.add('is-live');
    if (!count) return;
    const DURATION = 1400;
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / DURATION);
      // Same ease-out shape the bar uses, so the number lands with the fill
      // rather than racing ahead of it.
      const eased = 1 - Math.pow(1 - t, 3);
      count.textContent = Math.round(to * eased) + ' joining in';
      if (t < 1) requestAnimationFrame(step); else settle();
    };
    requestAnimationFrame(step);
  };

  new IntersectionObserver((entries, obs) => {
    entries.forEach((e) => { if (e.isIntersecting) { run(); obs.disconnect(); } });
  }, { threshold: 0.4 }).observe(media);
});

// The breaker board claims its spots once, when first seen. Everything visual
// is CSS off .is-running; JS only sets the per-tile delay and tallies the
// counter, which is a number rather than a property.
document.querySelectorAll('.bk-live').forEach((board) => {
  const tiles = Array.from(board.querySelectorAll('.bk-tile'));
  const counter = board.querySelector('.bk-live__count');
  const taken = tiles.filter((t) => !t.classList.contains('is-open')).length;
  const STEP = 190;

  const finish = () => { if (counter) counter.textContent = taken + ' / ' + tiles.length; };

  if (REDUCED || !('IntersectionObserver' in window)) {
    board.classList.add('is-running');
    finish();
    return;
  }

  tiles.forEach((t, i) => t.style.setProperty('--d', (i * STEP) + 'ms'));

  new IntersectionObserver((entries, obs) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      obs.disconnect();
      board.classList.add('is-running');
      // The counter climbs in step with the tiles rather than jumping at the
      // end, so the number and the picture tell the same story.
      let n = 0;
      tiles.forEach((t, i) => {
        if (t.classList.contains('is-open')) return;
        setTimeout(() => { n += 1; if (counter) counter.textContent = n + ' / ' + tiles.length; }, i * STEP + 260);
      });
      setTimeout(finish, tiles.length * STEP + 400);
    });
  }, { threshold: 0.35 }).observe(board);
});

// Scroll-reveal
const revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && revealEls.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  revealEls.forEach((el) => observer.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add('is-visible'));
}
