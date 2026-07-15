// RYLI marketing site — vanilla JS, no build step, no framework.

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

  const dots = slides.map((_, i) => {
    const dot = document.createElement('button');
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.addEventListener('click', () => {
      slides[i].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
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
    slides[clamped].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
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

  if (autoplayMs) {
    let userInteracting = false;
    track.addEventListener('pointerdown', () => { userInteracting = true; stopAutoplay(); });
    track.addEventListener('pointerup', () => { userInteracting = false; restartAutoplay(); });
    carousel.addEventListener('mouseenter', stopAutoplay);
    carousel.addEventListener('mouseleave', () => { if (!userInteracting) startAutoplay(); });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        entries.forEach((entry) => (entry.isIntersecting ? startAutoplay() : stopAutoplay()));
      }, { threshold: 0.3 }).observe(carousel);
    } else {
      startAutoplay();
    }
  }
});

// Showcase toggle (Stream Store / Themes & FX)
document.querySelectorAll('.showcase-toggle__btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.showPanel;
    document.querySelectorAll('.showcase-toggle__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('.showcase-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === target));
  });
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

// Email capture forms (Formspree) — every CTA on the page posts to the
// same endpoint. TODO: replace FORMSPREE_ENDPOINT once the Formspree
// account exists (see README.md).
const FORMSPREE_ENDPOINT = 'https://formspree.io/f/REPLACE_ME';

document.querySelectorAll('form[data-email-form]').forEach((form) => {
  const status = form.querySelector('.form-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (FORMSPREE_ENDPOINT.includes('REPLACE_ME')) {
      if (status) {
        status.textContent = 'Signup isn’t connected yet — check back soon.';
        status.className = 'form-status err';
      }
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalLabel = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }
    try {
      const res = await fetch(FORMSPREE_ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form),
      });
      if (res.ok) {
        form.reset();
        if (status) {
          status.textContent = 'You’re on the list — we’ll email you at launch.';
          status.className = 'form-status ok';
        }
      } else {
        throw new Error('Request failed');
      }
    } catch (err) {
      if (status) {
        status.textContent = 'Something went wrong — please try again.';
        status.className = 'form-status err';
      }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
    }
  });
});
