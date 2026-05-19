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
