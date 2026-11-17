// Shared by hub.js (PUBLISH_TOKEN) and worker.js (ADMIN_TOKEN) -- two
// different trust levels, same comparison requirement either way.
export function timingSafeEqual(a, b) {
  // Token length is not the secret, only its content is, so a length check
  // up front is fine -- what must not leak is WHICH byte differs, which is
  // why the compare below never short-circuits on the first mismatch.
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
