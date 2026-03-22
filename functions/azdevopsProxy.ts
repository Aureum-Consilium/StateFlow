/**
 * azdevopsProxy — Backend proxy for Azure DevOps REST API
 *
 * All Azure DevOps traffic is routed through this function.
 * The PAT is sent by the browser in the request body and used here
 * for HTTP Basic Auth — it is never stored server-side.
 *
 * Authentication gate: every request validates the Base44 session
 * before making any Azure DevOps API call.
 *
 * Supported actions:
 *   fetchProjects      — List all projects in the organisation
 *   fetchTeams         — List all teams in a project
 *   fetchTeamAreaPaths — Get area paths owned by a team
 *   fetchWorkItems     — WIQL query + batch fetch work item details
 *   fetchByEpicId      — Recursive tree query for one epic + descendants
 *   fetchIterations    — Fetch all team iterations (sprint schedules)
 */

import { base44 } from "npm:@base44/sdk";

// Work item fields fetched for every item
const FIELDS = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.Parent",
  "System.CreatedDate",
  "System.ChangedDate",
  "System.AreaPath",
  "System.IterationPath",
  "Microsoft.VSTS.Scheduling.StoryPoints",
  "Microsoft.VSTS.Scheduling.Effort",
  "Microsoft.VSTS.Scheduling.RemainingWork",
  "Microsoft.VSTS.Scheduling.OriginalEstimate",
  "Microsoft.VSTS.Scheduling.CompletedWork",
  "Microsoft.VSTS.Scheduling.TargetDate",
  "Microsoft.VSTS.Scheduling.FinishDate",
  "Microsoft.VSTS.Scheduling.StartDate",
  "Custom.SynergyInvestmentQuarter",
  "Custom.WBSOChapter",
  "Custom.SynergyRequestID",
  "Custom.ExactOnlineProject",
  "Custom.StatusGAR",
  "Custom.Developmentstatus",
  "Custom.EstimatedDevDays",
].join(",");

const WIQL_PAGE_SIZE = 5000;
const BATCH_SIZE = 200;
const MAX_CONCURRENT_BATCHES = 5;
const DEFAULT_MAX_PAGES = 3;

// ─── Auth helper ────────────────────────────────────────────────────────────

function basicAuth(pat: string): string {
  return "Basic " + btoa(`:${pat}`);
}

// ─── Azure DevOps fetch wrapper ──────────────────────────────────────────────

async function adoFetch(url: string, pat: string, options: RequestInit = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: basicAuth(pat),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure DevOps error ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Batch fetch work item details ──────────────────────────────────────────

async function batchFetchItems(ids: number[], org: string, pat: string) {
  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    batches.push(ids.slice(i, i + BATCH_SIZE));
  }

  const results: unknown[] = [];
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
    const chunk = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
    const responses = await Promise.all(
      chunk.map((batch) => {
        const url = `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${batch.join(",")}&fields=${FIELDS}&api-version=7.1`;
        return adoFetch(url, pat);
      })
    );
    for (const r of responses) {
      results.push(...(r.value || []));
    }
  }
  return results;
}

// ─── WIQL query + paginated ID collection ───────────────────────────────────

async function runWiqlQuery(
  wiql: string,
  org: string,
  pat: string,
  maxPages = DEFAULT_MAX_PAGES
): Promise<{ ids: number[]; truncated: boolean }> {
  const url = `https://dev.azure.com/${org}/_apis/wit/wiql?api-version=7.1`;
  let ids: number[] = [];
  let truncated = false;
  let page = 0;

  while (page < maxPages) {
    const body = JSON.stringify({ query: wiql });
    const data = await adoFetch(url, pat, { method: "POST", body });
    const pageIds: number[] = (data.workItems || []).map((w: { id: number }) => w.id);
    ids = ids.concat(pageIds);

    if (pageIds.length < WIQL_PAGE_SIZE) break;
    page++;
    if (page >= maxPages) {
      truncated = true;
      break;
    }
  }

  return { ids, truncated };
}

// ─── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  // Auth gate — only authenticated Base44 users may use this proxy
  const user = await base44.auth.me();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { action, org, project, team, pat, epicId, filters, maxPages } = body;

  if (!org || !pat) {
    return Response.json({ error: "Missing org or PAT" }, { status: 400 });
  }

  try {
    switch (action) {
      // ── List projects ──────────────────────────────────────────────────────
      case "fetchProjects": {
        const data = await adoFetch(
          `https://dev.azure.com/${org}/_apis/projects?api-version=7.1`,
          pat
        );
        return Response.json(data);
      }

      // ── List teams ─────────────────────────────────────────────────────────
      case "fetchTeams": {
        const data = await adoFetch(
          `https://dev.azure.com/${org}/${project}/_apis/projects/${project}/teams?api-version=7.1`,
          pat
        );
        return Response.json(data);
      }

      // ── Team area paths ────────────────────────────────────────────────────
      case "fetchTeamAreaPaths": {
        const data = await adoFetch(
          `https://dev.azure.com/${org}/${project}/${team}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`,
          pat
        );
        return Response.json(data);
      }

      // ── Fetch iterations (sprint schedules) ───────────────────────────────
      case "fetchIterations": {
        const data = await adoFetch(
          `https://dev.azure.com/${org}/${project}/${team}/_apis/work/teamsettings/iterations?api-version=7.1`,
          pat
        );
        return Response.json(data);
      }

      // ── Main work item fetch (WIQL + batch) ───────────────────────────────
      case "fetchWorkItems": {
        const {
          areaPath,
          iterationPath,
          createdFrom,
          createdTo,
          teamAreaPaths,
        } = filters || {};

        let whereClause = `[System.TeamProject] = '${project}'`;

        if (teamAreaPaths?.length) {
          const underClauses = teamAreaPaths
            .map((p: string) => `[System.AreaPath] UNDER '${p}'`)
            .join(" OR ");
          whereClause += ` AND (${underClauses})`;
        } else if (areaPath) {
          whereClause += ` AND [System.AreaPath] UNDER '${areaPath}'`;
        }

        if (iterationPath) {
          whereClause += ` AND [System.IterationPath] UNDER '${iterationPath}'`;
        }
        if (createdFrom) {
          whereClause += ` AND [System.CreatedDate] >= '${createdFrom}'`;
        }
        if (createdTo) {
          whereClause += ` AND [System.CreatedDate] <= '${createdTo}'`;
        }

        const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${whereClause} ORDER BY [System.Id]`;
        const { ids, truncated } = await runWiqlQuery(wiql, org, pat, maxPages || DEFAULT_MAX_PAGES);
        const items = ids.length > 0 ? await batchFetchItems(ids, org, pat) : [];

        return Response.json({ items, truncated });
      }

      // ── Fetch by Epic ID (recursive tree) ─────────────────────────────────
      case "fetchByEpicId": {
        const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE (SOURCE.[System.Id] = ${epicId}) MODE (Recursive) ORDER BY [System.Id]`;
        const url = `https://dev.azure.com/${org}/_apis/wit/wiql?api-version=7.1`;
        const data = await adoFetch(url, pat, {
          method: "POST",
          body: JSON.stringify({ query: wiql }),
        });

        const ids: number[] = [
          ...new Set(
            (data.workItemRelations || [])
              .flatMap((r: { source?: { id: number }; target?: { id: number } }) =>
                [r.source?.id, r.target?.id].filter(Boolean)
              )
          ),
        ] as number[];

        const items = ids.length > 0 ? await batchFetchItems(ids, org, pat) : [];
        return Response.json({ items, truncated: false });
      }

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[azdevopsProxy] Error in action '${action}':`, message);
    return Response.json({ error: message }, { status: 500 });
  }
}
