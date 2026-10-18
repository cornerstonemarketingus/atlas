import { randomUUID } from 'node:crypto';

/** Public failure contract: diagnostic text never crosses this boundary. */
export function customerFailure(operation, status = 503) {
  const reference = randomUUID();
  const billing = operation === 'checkout' || operation === 'portal';
  // Correlate failures without logging provider payloads, credentials or account data.
  console.error('[Atlas customer request failed]', { operation, reference });
  return Response.json({
    code: billing ? 'BILLING_UNAVAILABLE' : 'ACCOUNT_REQUEST_UNAVAILABLE',
    message: billing ? 'Billing is temporarily unavailable. Try again shortly.' : 'We could not confirm your account request. Refresh the page before trying again.',
    reference,
  }, { status, headers: { 'cache-control': 'no-store' } });
}
