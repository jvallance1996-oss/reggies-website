(() => {
  'use strict';
  const menuButton = document.querySelector('.nav-toggle');
  const menu = document.querySelector('#main-nav');
  if (menuButton && menu) {
    const close = () => { menu.dataset.open = 'false'; menuButton.setAttribute('aria-expanded', 'false'); };
    menuButton.addEventListener('click', () => {
      const open = menuButton.getAttribute('aria-expanded') !== 'true';
      menuButton.setAttribute('aria-expanded', String(open)); menu.dataset.open = String(open);
    });
    menu.addEventListener('click', event => { if (event.target.closest('a')) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  }

  const form = document.querySelector('#quickQuoteForm');
  if (form) {
    const field = name => form.elements.namedItem(name);
    const error = document.querySelector('#form-error');
    const submit = form.querySelector('button[type="submit"]');
    const photos = document.querySelector('#photos');
    const photoList = document.querySelector('#photo-list');
    const success = document.querySelector('#quote-success');
    const phoneField = document.querySelector('#phone-field');
    const emailField = document.querySelector('#email-field');
    let selectedPhotos = [], sending = false, requestId = '', lastPayload = '';
    const hints = {
      'lawn-mowing': 'Helpful details: regular or one-off mowing, grass height, lawn size, access and clippings.',
      'rubbish-removal': 'Helpful details: what needs removing, the whole load, access, stairs or heavy items.',
      'acreage-mowing-slashing': 'Helpful details: approximate area, long grass, slopes, obstacles and vehicle access.',
      gardening: 'Helpful details: garden beds, pruning or hedges, what to keep, access and green-waste removal.',
      'pressure-washing': 'Helpful details: the surface, approximate area, access and what needs cleaning.'
    };
    function contactMode() {
      const email = field('contactPreference').value === 'email';
      phoneField.hidden = email; emailField.hidden = !email;
      field('phone').required = !email; field('email').required = email;
      document.querySelector('#phone-label').textContent = field('contactPreference').value === 'call' ? 'Phone number' : 'Mobile number';
    }
    function serviceHint() { document.querySelector('#job-hint').textContent = hints[field('service').value] || 'Tell us what needs doing and any access details.'; }
    field('contactPreference').addEventListener('change', contactMode);
    field('service').addEventListener('change', serviceHint);
    const params = new URLSearchParams(location.search);
    if (params.get('service') && Object.hasOwn(hints, params.get('service'))) field('service').value = params.get('service');
    contactMode(); serviceHint();
    form.addEventListener('focusin', () => document.body.classList.add('form-active'));
    form.addEventListener('focusout', () => setTimeout(() => {
      if (!form.contains(document.activeElement)) document.body.classList.remove('form-active');
    }, 0));
    function showError(message, fields) {
      const guidance = fields && typeof fields === 'object' ? [...new Set(Object.values(fields).filter(value => typeof value === 'string'))].join(' ') : '';
      error.textContent = guidance ? `${message} ${guidance}` : message; error.hidden = false;
      for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
      let first;
      if (fields && typeof fields === 'object') {
        for (const name of Object.keys(fields)) {
          const input = field(name);
          if (input instanceof HTMLElement) { input.setAttribute('aria-invalid', 'true'); first ||= input; }
        }
      }
      if (first) {
        for (let ancestor = first.parentElement; ancestor && ancestor !== form; ancestor = ancestor.parentElement) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        }
        first.focus();
      } else { error.tabIndex = -1; error.focus(); }
    }
    function renderPhotos() {
      photoList.replaceChildren();
      selectedPhotos.forEach((file, index) => {
        const row = document.createElement('li');
        const label = document.createElement('span'); label.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.addEventListener('click', () => { selectedPhotos.splice(index, 1); renderPhotos(); });
        row.append(label, remove); photoList.append(row);
      });
    }
    photos.addEventListener('change', () => {
      const incoming = Array.from(photos.files || []);
      photos.value = '';
      if (selectedPhotos.length + incoming.length > 4) return showError('Please add up to 4 photos. You can remove a photo below or send the request without photos.');
      for (const file of incoming) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return showError('Please use JPG, PNG or WebP photos. You can also send your enquiry without photos.');
        if (file.size > 3 * 1024 * 1024) return showError('Each photo needs to be 3 MB or smaller. Try a smaller image or send your enquiry without photos.');
      }
      selectedPhotos.push(...incoming); renderPhotos(); error.hidden = true;
    });
    const readPhoto = file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result).split(',')[1] });
      reader.onerror = () => reject(new Error('A photo could not be read. Remove it and try again, or continue without photos.'));
      reader.readAsDataURL(file);
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (sending || !form.reportValidity()) return;
      error.hidden = true; sending = true; submit.disabled = true;
      submit.textContent = selectedPhotos.length ? 'Preparing your photos…' : 'Sending your request…';
      let timer;
      try {
        const payload = {
          name: field('name').value.trim(), suburb: field('suburb').value.trim(), service: field('service').value,
          contactPreference: field('contactPreference').value,
          phone: field('contactPreference').value === 'email' ? '' : field('phone').value.trim(),
          email: field('contactPreference').value === 'email' ? field('email').value.trim() : '',
          details: field('details').value.trim(), timing: field('timing').value.trim(), jobType: field('jobType').value,
          website: field('website').value, photos: await Promise.all(selectedPhotos.map(readPhoto))
        };
        const signature = JSON.stringify(payload);
        if (!requestId || signature !== lastPayload) { requestId = crypto.randomUUID(); lastPayload = signature; }
        const controller = new AbortController(); timer = setTimeout(() => controller.abort(), 30000);
        submit.textContent = 'Sending your request…';
        const response = await fetch('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, requestId }), signal: controller.signal });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result || result.ok !== true) {
          showError(result?.error || 'We couldn’t confirm receipt. Your details are still here — please try again, or text Jack on 0437 844 844.', result?.fields);
          return;
        }
        const replies = { sms: 'text message', email: 'email', call: 'phone call' };
        document.querySelector('#success-message').textContent = `Thanks, ${payload.name}. Jack will get back to you by ${replies[payload.contactPreference]}.`;
        document.querySelector('#quote-reference').textContent = result.reference ? `Your reference: ${result.reference}` : '';
        form.hidden = true; success.hidden = false; success.focus();
        selectedPhotos = []; photoList.replaceChildren();
        document.body.classList.remove('form-active');
      } catch (cause) {
        showError(cause?.name === 'AbortError'
          ? 'We couldn’t confirm receipt yet. Your details are still here. Try again safely, or text Jack on 0437 844 844.'
          : cause?.message?.startsWith('A photo') ? cause.message : 'We couldn’t send your request. Your details are still here — please retry or text Jack on 0437 844 844.');
      } finally {
        clearTimeout(timer); sending = false; submit.disabled = false; submit.textContent = 'Request my quote ↗';
      }
    });
    document.querySelector('#new-request').addEventListener('click', () => {
      form.reset(); field('service').value = form.dataset.service || ''; field('suburb').value = form.dataset.suburb || '';
      contactMode(); serviceHint(); requestId = ''; lastPayload = ''; error.hidden = true;
      success.hidden = true; form.hidden = false; field('service').focus();
    });
  }
})();

// Keep the existing scheduled Google review feed and its freshness fallback.

const reviewGrid = document.querySelector("#googleReviewGrid");
const reviewSummary = document.querySelector("#googleReviewSummary");

function renderStars(rating) {
  const rounded = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
  return `${"★".repeat(rounded)}${"☆".repeat(5 - rounded)}`;
}

function renderGoogleReviews(data) {
  if (!reviewGrid || !reviewSummary || !Array.isArray(data.reviews) || !data.reviews.length) return;

  reviewGrid.replaceChildren();

  data.reviews.slice(0, 3).forEach((review) => {
    const card = document.createElement("article");
    card.className = "review-card";

    const stars = document.createElement("div");
    stars.className = "stars";
    stars.setAttribute("aria-label", `${review.rating} star Google review`);
    stars.textContent = renderStars(review.rating);

    const quote = document.createElement("p");
    quote.textContent = `“${review.text}”`;

    const byline = document.createElement("div");
    const author = document.createElement(review.authorUri ? "a" : "strong");
    author.textContent = review.author || "Google reviewer";
    if (review.authorUri) {
      author.href = review.authorUri;
      author.target = "_blank";
      author.rel = "noopener";
      author.className = "review-author";
    }

    const detail = document.createElement("span");
    detail.textContent = review.relativeTime
      ? `${review.rating}-star Google review · ${review.relativeTime}`
      : `${review.rating}-star Google review`;

    byline.append(author, detail);
    card.append(stars, quote, byline);
    reviewGrid.append(card);
  });

  const rating = Number(data.rating).toFixed(1);
  const checked = new Date(data.updatedAt);
  const validDate = Number.isFinite(checked.getTime());
  const stale = !validDate || Date.now() - checked.getTime() > 30 * 86400000;
  const dateLabel = validDate ? checked.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Melbourne" }) : "";
  reviewSummary.textContent = stale
    ? "See our latest customer rating and reviews on Google."
    : `Reggie's Lawn and Outdoor Solutions is rated ${rating} on Google from ${data.reviewCount} reviews (checked ${dateLabel}).`;
}

if (reviewGrid && reviewSummary) {
  fetch("/google-reviews.json", { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error("Review feed unavailable");
      return response.json();
    })
    .then(renderGoogleReviews)
    .catch(() => {
      // Keep the server-rendered review highlights visible as a reliable fallback.
    });
}
