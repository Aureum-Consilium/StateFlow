# Architecture

## Overview

StateFlow is a React + TypeScript SPA deployed on Base44. It never calls Azure DevOps directly from the browser — all API traffic is routed through a Deno backend proxy function (`azdevopsProxy`).

```
┌────────────────────────────────────────────┐
│  Browser                                   │
│  ┌──────────────────────────────────────┐  │
│  │  React SPA (Vite + TypeScript)       │  │
│  │  - TanStack Query for data fetching  │  │
│  │  - React Router v6 for navigation    │  │
│  │  - Tailwind + shadcn/ui for styling  │  │
│  │  - PAT stored in localStorage        │  │
│  │  - Work items cached in sessionStorage│ │
│  └──────────────┬───────────────────────┘  │
└─────────────────┼──────────────────────────┘
                  │ HTTPS (POST)
                  ▼
┌────────────────────────────────────────────┐
│  Base44 Backend (Deno)                     │
│  azdevopsProxy function                    │
│  - Validates Base44 session (auth gate)    │
│  - Forwards PAT via HTTP Basic Auth        │
│  - Handles all Azure DevOps REST calls     │
└──────────────────┬─────────────────────────┘
                   │ HTTPS + Basic Auth
                   ▼
┌────────────────────────────────────────────┐
│  Azure DevOps REST API                     │
│  dev.azure.com                             │
└────────────────────────────────────────────┘
```

## Proxy Actions

| Action             | Azure DevOps Endpoint                                      |
|--------------------|------------------------------------------------------------|
| fetchProjects      | GET `/{org}/_apis/projects`                                |
| fetchTeams         | GET `/{org}/{project}/_apis/projects/{project}/teams`      |
| fetchTeamAreaPaths | GET `/{org}/{project}/{team}/_apis/work/teamsettings/teamfieldvalues` |
| fetchWorkItems     | POST `/_apis/wit/wiql` → GET `/_apis/wit/workitems?ids=…`  |
| fetchByEpicId      | POST `/_apis/wit/wiql` (Recursive) → batch fetch           |
| fetchIterations    | GET `/{org}/{project}/{team}/_apis/work/teamsettings/iterations` |

## Data Flow

1. User enters org, project, PAT in Settings → saved to `localStorage`
2. User clicks **Fetch** → frontend sends action + credentials to proxy
3. Proxy validates Base44 session → calls Azure DevOps → returns data
4. Frontend assembles hierarchy tree from `System.Parent` links
5. Metrics rolled up from leaves (Tasks/PBIs) to roots (Epics)
6. RAG status calculated per item → rendered in table
7. Data cached in `sessionStorage` for hot-reload resilience

## Hierarchy

```
Epic
 └── Feature
      └── Product Backlog Item / User Story
           └── Task / Bug
```

Metrics (Estimate, Remaining, Completed) are recursively summed from children to parents.
