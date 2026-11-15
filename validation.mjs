export const SERVICES = new Set(['lawn-mowing', 'rubbish-removal', 'acreage-mowing-slashing', 'gardening', 'pressure-washing']);
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function text(value, max, field, errors, required = false, multiline = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') { errors[field] = 'Enter text for this field.'; return ''; }
  value = value.trim();
  if (required && !value) errors[field] = 'Complete this field.';
  if (value.length > max) errors[field] = `Use ${max} characters or fewer.`;
  if (CONTROL.test(value) || (!multiline && /[\r\n]/.test(value))) errors[field] = 'Remove unsupported characters.';
  return value;
}

function matchesSignature(type, bytes) {
  if (type === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (type === 'image/png') return bytes.length >= 20 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString('ascii') === 'IHDR';
  return bytes.length >= 16 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString('ascii'));
}

export function validateQuote(input) {
  const fields = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fields: { form: 'Send a JSON object.' } };
  const allowed = new Set(['requestId', 'name', 'suburb', 'service', 'contactPreference', 'phone', 'email', 'details', 'timing', 'jobType', 'photos', 'website']);
  if (Object.keys(input).some(key => !allowed.has(key))) fields.form = 'Remove unsupported fields.';
  const requestId = text(input.requestId, 36, 'requestId', fields, true).toLowerCase();
  if (!UUID.test(requestId)) fields.requestId = 'Start a new quote request and try again.';
  const name = text(input.name, 100, 'name', fields, true);
  const suburb = text(input.suburb, 100, 'suburb', fields, true);
  if (/[<>]/.test(name)) fields.name = 'Enter your name as plain text.';
  if (suburb && !/^[\p{L}\p{N}\s.'’()-]+$/u.test(suburb)) fields.suburb = 'Enter a suburb or postcode.';
  const service = text(input.service, 40, 'service', fields, true);
  if (!SERVICES.has(service)) fields.service = 'Choose a listed service.';
  const contactPreference = text(input.contactPreference, 10, 'contactPreference', fields, true);
  if (!['sms', 'email', 'call'].includes(contactPreference)) fields.contactPreference = 'Choose text, email or call.';
  let phone = text(input.phone, 40, 'phone', fields);
  const email = text(input.email, 254, 'email', fields).toLowerCase();
  if (phone && !/^[+\d\s()-]+$/.test(phone)) fields.phone = 'Enter a valid Australian phone number.';
  phone = phone.replace(/[\s()-]/g, '');
  if (phone.startsWith('61')) phone = `+${phone}`;
  const validPhone = /^(?:\+61|0)[23478]\d{8}$/.test(phone);
  const validMobile = /^(?:\+61|0)4\d{8}$/.test(phone);
  const validEmail = /^[^\s<>@]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email);
  if (phone && !validPhone) fields.phone = 'Enter a valid Australian phone number.';
  if (email && !validEmail) fields.email = 'Enter a valid email address.';
  if (contactPreference === 'sms' && !validMobile) fields.phone = 'Enter an Australian mobile number for text replies.';
  if (contactPreference === 'call' && !validPhone) fields.phone = 'Enter a phone number for call replies.';
  if (contactPreference === 'email' && !validEmail) fields.email = 'Enter an email address for email replies.';
  const details = text(input.details, 4000, 'details', fields, false, true);
  const timing = text(input.timing, 200, 'timing', fields);
  const jobType = text(input.jobType, 100, 'jobType', fields);
  const website = text(input.website, 200, 'website', fields);
  if (website) fields.form = 'Unable to submit this request. Please text or call instead.';
  const photos = [];
  if (input.photos !== undefined && !Array.isArray(input.photos)) fields.photos = 'Choose up to four photos.';
  else if ((input.photos?.length || 0) > 4) fields.photos = 'Choose four photos or fewer.';
  else for (const [index, photo] of (input.photos || []).entries()) {
    if (!photo || typeof photo !== 'object' || Array.isArray(photo) || Object.keys(photo).some(key => !['name', 'type', 'data'].includes(key))) {
      fields.photos = 'One photo could not be read.'; break;
    }
    const type = photo.type;
    const data = photo.data;
    if (!MIME.has(type) || typeof data !== 'string' || data.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      fields.photos = 'Use JPEG, PNG or WebP photos up to 3 MB each.'; break;
    }
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_PHOTO_BYTES || bytes.toString('base64') !== data || !matchesSignature(type, bytes)) {
      fields.photos = 'One photo has an unsupported or damaged file format.'; break;
    }
    const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : 'webp';
    // Store a generated safe name; never trust the client filename as a path or mail header.
    photos.push({ name: `job-photo-${index + 1}.${extension}`, type, bytes });
  }
  return Object.keys(fields).length ? { fields } : {
    requestId,
    payload: { name, suburb, service, contactPreference, phone, email, details, timing, jobType },
    photos,
  };
}
