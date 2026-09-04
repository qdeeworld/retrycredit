export const SAME_ORIGIN_API_ORIGIN = "";
export const PRODUCTION_API_ORIGIN = "https://retrycredit-api.onrender.com";
export const STAGING_API_ORIGIN = "https://retrycredit-api-staging.qdworld001.workers.dev";

const ALLOWED_API_ORIGINS = new Set([
  SAME_ORIGIN_API_ORIGIN,
  PRODUCTION_API_ORIGIN,
  STAGING_API_ORIGIN,
]);

export function cloudflareHeadersForApiOrigin(apiOrigin) {
  if (!ALLOWED_API_ORIGINS.has(apiOrigin)) {
    throw new Error("Refusing to generate Cloudflare headers for an unapproved API origin.");
  }
  const apiSource = apiOrigin ? ` ${apiOrigin}` : "";
  return `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'${apiSource}; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
`;
}
