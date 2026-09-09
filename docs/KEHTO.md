# Experimental Cashu capability

This is a Bearlett-specific extension, not an adopted NAP. Stock NAP-RESOURCE
does not support Cashu POST operations. Browser CORS still applies to host fetches.

`contributions/kehto-cashu.patch` adds ACL resolution and persistent bits,
source-bound dispatch, correlated denial replies, discovery, a protected injected
shim, a reference service and tests. ACL/firewall audits retain message types,
never bearer payloads. Cashu requires opt-in even under permissive defaults.

## Host wiring

After applying the patch and rebuilding Kehto:

```ts
import {createCashuService} from '@kehto/services'

runtime.registerService(
  'cashu',
  createCashuService({
    scope: windowId => trustedWalletStorageScope(windowId),
    allowed: (windowId, mint) => approvedMintsForWindow(windowId).has(mint)
  })
)
```

These callbacks belong to your host. Obtain scope from authenticated session
identity, never from request data. Approve full canonical HTTPS mint URLs,
including paths, in the host permission UI. Grant `cashu:request` to the artifact
identity. Register the service before computing shell capabilities. Notify runtime
window destruction to release leases. Reuse Wallet windows even without Cashu.

Both napplets await Kehto's `shell.ready()` handshake. Bearlett enables Cashu
only if the granted namespace includes `.request()` and `.acquire()`.

## Contract

```ts
type CashuRequest = {
  mint: string
  operation:
    | 'info'
    | 'keysets'
    | 'keys'
    | 'mintQuote'
    | 'mintQuoteState'
    | 'mint'
    | 'swap'
    | 'meltQuote'
    | 'meltQuoteState'
    | 'melt'
    | 'checkstate'
    | 'restore'
  parameter?: string // keyset/quote ID
  body?: string // exact JSON bytes for POST
}
type CashuResponse = {status: number; body: string; retryAfterMs?: number}
```

Requests: `{type:'cashu.request', id, request}` or `{type:'cashu.acquire', id}`.
Replies: `${type}.result`, the same `id`, `ok`, and `result` or redacted `error`.
Only parent-origin replies resolve shim promises. Unknown message types are ignored.

The service maps to fixed `/v1` endpoints, rejects credentials, query/fragment,
traversal and unsupported fields, bounds message sizes, and fetches with cookies,
redirects, cache and referrers disabled. No arbitrary headers/URLs are exposed.
One request per window is permitted at a time. Timeouts never retry.

`src/host/` contains the independent reference also used by the preview, which
approves only its test mint and never accesses live mints.
