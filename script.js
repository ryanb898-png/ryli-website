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

  let scrollTimeout;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => setActive(currentIndex()), 80);
  });

  prevBtn.addEventListener('click', () => {
    const idx = Math.max(0, currentIndex() - 1);
    slides[idx].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  });
  nextBtn.addEventListener('click', () => {
    const idx = Math.min(slides.length - 1, currentIndex() + 1);
    slides[idx].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
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
