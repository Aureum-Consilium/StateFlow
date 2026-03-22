# Security & Privacy

## Credential Handling

| What                          | Where it lives           | Why it is safe                                                                 |
|-------------------------------|--------------------------|---------------------------------------------------------------------------------|
| Personal Access Token (PAT)   | Browser `localStorage`   | Never persisted server-side. Sent only over HTTPS in the encrypted request body to the proxy — not in a URL, header log, or cookie. |
| Organisation & Project name   | Browser `localStorage`   | Same transport as the PAT. Configuration values, not secrets, but treated identically. |
| Session data (work items)     | Browser `sessionStorage` | Cleared automatically when the tab or browser session ends. Never sent to the backend. |

## Backend Proxy Authentication Gate

Every request to `azdevopsProxy` begins with:

```typescript
const user = await base44.auth.me();
if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
```

Only authenticated Base44 users can invoke the proxy — unauthenticated requests are rejected before any Azure DevOps API call is made.

## No Direct Browser → Azure DevOps Calls

```
Browser → Base44 proxy (HTTPS) → dev.azure.com (HTTPS)
```

This eliminates CORS-based credential leakage and prevents the PAT from being intercepted by browser extensions or network inspection of response headers.

## Minimal PAT Scopes (Principle of Least Privilege)

The dashboard is read-only. Recommended PAT scopes:

- **Work Items (Read)**
- **Project and Team (Read)**

The proxy never writes to Azure DevOps. Even if a PAT were compromised, no work items could be modified through this dashboard.

## sessionStorage — Privacy by Default

Work item data is cached in `sessionStorage`, which is:

- **Tab-scoped** — not shared between tabs or windows
- **Session-scoped** — wiped when the tab is closed, not persisted across browser restarts

Closing the tab effectively clears all cached work item data.

## Known Limitations & User Responsibilities

- ⚠️ The PAT is in `localStorage` (persistent). On **shared or public machines**, use private/incognito mode and clear site data after use.
- The proxy logs the user's Base44 identity but **does not log** the PAT or work item content.
- Data in transit is protected by TLS (HTTPS). Work item titles and metadata are not end-to-end encrypted between the proxy and your browser — standard HTTPS applies.
