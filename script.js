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
