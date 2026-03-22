# StateFlow DevOps — Delivery Dashboard

> v1.0 — Real-Time Delivery Visibility · Know Your Project Status at a Glance

A high-visibility delivery dashboard that rolls up tasks and PBIs into epic-level progress tracking for seamless project management. Built on [Base44](https://base44.com) with React, TypeScript, Tailwind CSS, and a secure Azure DevOps proxy backend.

---

## What You Get

- **One unified view** of all epics, features, and tasks by team
- **Smart RAG status indicators** — On Track, At Risk, Behind Schedule, Past Deadline
- **Team-focused filtering** for your specific work scope
- **Export and reporting** for stakeholder updates
- **Secure by design** — PAT never stored server-side

## Who It's For

- Engineering leaders
- Delivery managers
- Program managers
- Anyone who needs delivery health visibility without friction

---

## Architecture Overview

```
Browser (React + TypeScript)
    ↓ HTTPS
Base44 Backend Proxy (azdevopsProxy — Deno)
    ↓ HTTPS + Basic Auth (PAT)
Azure DevOps REST API
```

- The PAT is stored in **browser localStorage only** — never persisted server-side
- All Azure DevOps traffic is routed through the secure backend proxy
- Only authenticated Base44 users can invoke the proxy

---

## Tech Stack

| Layer      | Technology                                      |
|------------|-------------------------------------------------|
| Frontend   | React, TypeScript, Tailwind CSS, shadcn/ui      |
| Data       | TanStack Query (React Query)                    |
| Routing    | React Router v6                                 |
| Backend    | Deno (Base44 serverless functions)              |
| Platform   | Base44 (auth, entities, deployment)             |
| Build      | Vite                                            |

---

## Getting Started

### Prerequisites

- A [Base44](https://base44.com) account
- An Azure DevOps organisation
- A PAT with the following scopes:
  - **Work Items (Read)**
  - **Project and Team (Read)**

### Setup

1. Deploy the `azdevopsProxy` backend function (see `functions/azdevopsProxy.ts`)
2. Open the app and go to **Settings**
3. Enter your Azure DevOps **Organisation**, **Project**, and **PAT**
4. Click **Fetch** to load your work items

---

## Filters

### Server-side (require data reload)

| Filter       | Behaviour                                                   |
|--------------|-------------------------------------------------------------|
| Team         | Filters by team-owned area paths via WIQL UNDER clause      |
| Area Path    | Adds `[System.AreaPath] UNDER '…'` to WIQL query            |
| Iteration    | Adds `[System.IterationPath] UNDER '…'` to WIQL query       |
| Created date | Adds `[System.CreatedDate] >= … AND <= …` to WIQL query     |
| Epic ID      | Runs a recursive tree query for one epic and all descendants|

### Client-side (instant, no reload)

| Filter       | Behaviour                                                   |
|--------------|-------------------------------------------------------------|
| Search       | Substring match on title or exact ID match                  |
| State        | Shows only Epics matching selected state                    |
| Hide closed  | Hides Closed / Done / Resolved / Removed items              |
| Deadline     | Hides items with deadline outside selected range            |

---

## RAG Status Logic

| Status           | Condition                                                             |
|------------------|-----------------------------------------------------------------------|
| ✅ On Time        | Complete + deadline not yet passed                                    |
| 🔴 Delivered Late | Complete + deadline already passed                                    |
| ⚫ No Deadline    | Incomplete + no deadline set                                          |
| 🔴 Past Deadline  | Incomplete + deadline already passed                                  |
| 🟢 On Track       | Incomplete + work progress within 10% of time progress               |
| 🟡 At Risk        | Incomplete + work progress 10–25% behind time progress               |
| 🔴 Behind         | Incomplete + work progress >25% behind time progress                 |

**Progress formula:**
```
timeProgress  = (today − startDate) / (deadline − startDate)
workProgress  = (estimate − remaining) / estimate
gap           = workProgress − timeProgress
```

---

## Date Resolution

### Epics & Features

| Date       | Priority                                              |
|------------|-------------------------------------------------------|
| Start Date | StartDate field → Investment Quarter start            |
| Deadline   | TargetDate field → Investment Quarter end             |

### PBIs & User Stories

| Date       | Priority                                                        |
|------------|-----------------------------------------------------------------|
| Start Date | FinishDate → TargetDate → Sprint finish → IQ end date           |
| Deadline   | StartDate → Sprint start → IQ start date                        |

### Investment Quarter mapping

| Quarter | Start      | End        |
|---------|------------|------------|
| Q1      | Jan 1      | Mar 31     |
| Q2      | Apr 1      | Jun 30     |
| Q3      | Jul 1      | Sep 30     |
| Q4      | Oct 1      | Dec 31     |

---

## Security

- ✅ PAT lives in browser `localStorage` only
- ✅ Backend proxy validates Base44 session before every request
- ✅ No direct browser → Azure DevOps calls (CORS-safe)
- ✅ Minimal PAT scopes (read-only)
- ✅ Work item data cached in `sessionStorage` (tab-scoped, cleared on close)
- ⚠️ On shared machines: use private/incognito mode and clear site data after use

---

## Pagination

- WIQL queries paginated in batches of **5,000 IDs**
- Default max: **3 pages (15,000 items)** — configurable up to 20 pages
- Full item details fetched in parallel batches of **200 IDs** (up to 5 concurrent)
- Warning banner shown if results are truncated

---

## Work Item Fields Fetched

| Category       | Fields                                                                 |
|----------------|------------------------------------------------------------------------|
| Core           | Id, Title, WorkItemType, State, Parent, CreatedDate, ChangedDate       |
| Area/Iteration | AreaPath, IterationPath                                                |
| Scheduling     | StoryPoints, Effort, RemainingWork, OriginalEstimate, CompletedWork    |
| Dates          | TargetDate, FinishDate, StartDate                                       |
| Custom         | SynergyInvestmentQuarter, WBSOChapter, SynergyRequestID, ExactOnlineProject, StatusGAR, Developmentstatus, EstimatedDevDays |

---

## License

Internal tool — proprietary.
