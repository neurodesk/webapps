/**
 * Reads of a store an agent opened stay where the person allowed: under the store root the consent
 * named, at its origin, with no redirect followed. The person's own loads are not confined.
 */

/**
 * The request to send for `request`, confined to `root` (a normalised store root without a trailing
 * slash): a request outside the root is refused before it is sent, and a redirect is not followed.
 * @param {string} root
 * @param {Request} request
 * @returns {Request}
 */
export function confinedRequest(root, request) {
  const base = new URL(root)
  const url = new URL(request.url)
  const inside = url.origin === base.origin && (url.pathname === base.pathname || url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`))
  if (!inside) throw new Error(`${url.href} lies outside ${root}, the store the person allowed the agent to open`)
  return new Request(request, { redirect: 'manual' })
}

/**
 * Throws when the answer to a confined request is a redirect, which a confined request never follows.
 * @param {Response} response
 * @param {string} address
 * @returns {Response}
 */
export function refuseRedirect(response, address) {
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new Error(`${address} redirects to another address; the agent's store reads only under the root the person allowed`)
  }
  return response
}
