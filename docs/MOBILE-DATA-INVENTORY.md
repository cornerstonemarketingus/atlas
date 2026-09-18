# Atlas mobile data inventory

This inventory is an engineering input for Apple privacy labels and Google Play Data Safety. It is not legal advice and must be checked against the final native binaries and enabled vendors before submission.

| Data | Purpose | Storage | Shared processor | Deletion |
| --- | --- | --- | --- | --- |
| GitHub user id, login, email, avatar | Authentication and account display | Cloudflare D1 | GitHub, Cloudflare | Account deletion |
| Session cookie | Authentication | User device; signed by Atlas | Cloudflare | Logout/expiry |
| Repository owner/name and branch | Run user-requested work | Cloudflare D1 | GitHub or configured forge | Account deletion |
| Task instructions, status, and safe progress events | Execute and explain work | Cloudflare D1 | Selected execution/model provider | Account deletion |
| Conversation messages and attachment metadata | Workspace continuity | Cloudflare D1 | Selected execution/model provider | Account deletion |
| Subscription ids and usage counters | Billing and entitlement | Cloudflare D1 | Stripe when enabled | Deletion, subject to legal retention |
| Paired-device name, platform, and credential hash | Secure computer pairing | Cloudflare D1 | Cloudflare | Account deletion or device revocation |
| Browser-task goals and approval receipts | User-requested computer operation and audit | Cloudflare D1 | Cloudflare; local companion | Account deletion |
| Local browser profile and encrypted operator profile | Local automation | User's Windows device | None by default | Companion uninstall/profile removal |

## Collection declarations

- Atlas does not sell user data or use customer repositories to train a proprietary model.
- Exact device pairing secrets remain on the paired device; the service stores a one-way digest.
- High-risk actions require an explicit approval receipt.
- Native crash reporting, analytics, advertising identifiers, contacts, location, health, and tracking are not currently implemented. Revisit the declarations before adding any SDK.
- Screenshots or accessibility content may contain data visible on a page. The shipped local companion uses accessibility snapshots locally; any future hosted-browser feature needs a separate disclosure.

## Release review

Before each store submission, compare this file with dependency manifests, network destinations, production configuration, privacy policy copy, retention jobs, and the account deletion processor. Record the reviewer and commit SHA in the release ticket.
