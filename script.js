const quoteForm = document.querySelector("#quickQuoteForm");

if (quoteForm) {
  quoteForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const formData = new FormData(quoteForm);
    const details = {
      name: formData.get("name") || "",
      phone: formData.get("phone") || "",
      email: formData.get("email") || "",
      suburb: formData.get("suburb") || "",
      service: formData.get("service") || "",
      message: formData.get("message") || "",
    };

    const body = [
      "New quote request for Reggie's Lawn and Outdoor Solutions",
      "",
      `Name: ${details.name}`,
      `Phone: ${details.phone}`,
      `Email: ${details.email}`,
      `Suburb: ${details.suburb}`,
      `Service: ${details.service}`,
      "",
      "Job details:",
      details.message,
    ].join("\n");

    const subject = `Quote request - ${details.service || "Outdoor work"} in ${details.suburb || "local area"}`;
    const mailto = `mailto:jack@reggies.com.au?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    window.location.href = mailto;
  });
}

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
  reviewSummary.textContent = `Reggie's Lawn and Outdoor Solutions is rated ${rating} on Google from ${data.reviewCount} reviews.`;
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
