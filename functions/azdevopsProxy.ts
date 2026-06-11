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
const MAX_ALLOWED_PAGES = 20;
const API_VERSION = "7.1";
const FETCH_TIMEOUT_MS = 10000;
const MAX_FETCH_RETRIES = 3;
const BACKOFF_BASE_MS = 300;
const BACKOFF_MAX_MS = 5000;
const MIN_REQUEST_INTERVAL_MS = 75;
const ERROR_BODY_MAX_CHARS = 2000;
const ERROR_BODY_TRUNCATION_SUFFIX = "...";
const ISO_DATE_TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const ALLOWED_ACTIONS = [
  "fetchProjects",
  "fetchTeams",
  "fetchTeamAreaPaths",
  "fetchWorkItems",
  "fetchByEpicId",
  "fetchIterations",
] as const;

type Action = (typeof ALLOWED_ACTIONS)[number];

interface WorkItem {
  id: number;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AdoListResponse<T> {
  value?: T[];
}

interface WiqlWorkItemRef {
  id: number;
}

interface WiqlResponse {
  workItems?: WiqlWorkItemRef[];
}

interface WorkItemLink {
  source?: { id: number };
  target?: { id: number };
}

interface WorkItemLinksResponse {
  workItemRelations?: WorkItemLink[];
}

interface WorkItemFilters {
  areaPath?: string;
  iterationPath?: string;
  createdFrom?: string;
  createdTo?: string;
  teamAreaPaths?: string[];
}

interface ProxyRequestBody {
  action: Action;
  org: string;
  project?: string;
  team?: string;
  pat: string;
  epicId?: number;
  filters?: WorkItemFilters;
  maxPages?: number;
}

class ProxyError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  details?: string;

  constructor(
    message: string,
    status: number,
    code: string,
    options?: { retryable?: boolean; details?: string }
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

let lastRequestAt = 0;
let rateLimitQueue: Promise<unknown> = Promise.resolve();

// ─── Auth helper ────────────────────────────────────────────────────────────

function basicAuth(pat: string): string {
  return "Basic " + btoa(`:${pat}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForRateLimitSlot(): Promise<void> {
  const slot = rateLimitQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = Date.now();
  });
  rateLimitQueue = slot.catch(() => undefined);
  return slot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ALLOWED_ACTIONS as readonly string[]).includes(value);
}

function escapeWiqlString(input: string): string {
  return input.replace(/'/g, "''");
}

function sanitizeForLog(input: string, pat?: string): string {
  let sanitized = input;
  if (pat) {
    sanitized = sanitized.split(pat).join("[REDACTED]");
  }
  return sanitized.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProxyError(`Missing or invalid ${fieldName}`, 400, "VALIDATION_ERROR");
  }
  return value.trim();
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeMaxPages(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_PAGES;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ALLOWED_PAGES) {
    throw new ProxyError(
      `maxPages must be an integer between 1 and ${MAX_ALLOWED_PAGES}`,
      400,
      "VALIDATION_ERROR"
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (!isPositiveInteger(value)) {
    throw new ProxyError(`${fieldName} must be a positive integer`, 400, "VALIDATION_ERROR");
  }
  return value;
}

function validateDateLiteral(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !ISO_DATE_TIME_REGEX.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ProxyError(`Invalid ${fieldName} date format`, 400, "VALIDATION_ERROR");
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

async function readErrorBody(response: Response, maxChars = ERROR_BODY_MAX_CHARS): Promise<string> {
  const body = await response.text();
  return body.length > maxChars
    ? `${body.slice(0, maxChars)}${ERROR_BODY_TRUNCATION_SUFFIX}`
    : body;
}

function normalizeFilters(value: unknown): WorkItemFilters | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ProxyError("filters must be an object", 400, "VALIDATION_ERROR");
  }

  const areaPath =
    value.areaPath === undefined ? undefined : requireString(value.areaPath, "filters.areaPath");
  const iterationPath =
    value.iterationPath === undefined
      ? undefined
      : requireString(value.iterationPath, "filters.iterationPath");
  const createdFrom = validateDateLiteral(value.createdFrom, "createdFrom");
  const createdTo = validateDateLiteral(value.createdTo, "createdTo");

  let teamAreaPaths: string[] | undefined;
  if (value.teamAreaPaths !== undefined) {
    if (!Array.isArray(value.teamAreaPaths) || value.teamAreaPaths.some((p) => !isNonEmptyString(p))) {
      throw new ProxyError("filters.teamAreaPaths must be an array of strings", 400, "VALIDATION_ERROR");
    }
    teamAreaPaths = value.teamAreaPaths.map((p) => p.trim());
  }

  return {
    areaPath,
    iterationPath,
    createdFrom,
    createdTo,
    teamAreaPaths,
  };
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError" || /timeout|timed out/i.test(err.message);
  }
  if (err instanceof TypeError) {
    return /fetch|network|socket|timeout|timed out|failed/i.test(err.message);
  }
  if (err instanceof Error) {
    return /timeout|timed out|network/i.test(err.message);
  }
  return err instanceof ProxyError && err.retryable;
}

function getRetryDelayMs(attempt: number, retryAfter?: string | null): number {
  const headerDelaySeconds = retryAfter ? Number(retryAfter) : NaN;
  if (!Number.isNaN(headerDelaySeconds) && headerDelaySeconds >= 0) {
    return Math.min(headerDelaySeconds * 1000, BACKOFF_MAX_MS);
  }
  const exponential = BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(exponential, BACKOFF_MAX_MS);
}

function pagedWiqlQuery(wiql: string, lastSeenId?: number): string {
  if (lastSeenId === undefined) {
    return wiql;
  }
  if (!isPositiveInteger(lastSeenId)) {
    throw new ProxyError("Invalid pagination cursor", 500, "INVALID_CURSOR");
  }
  const orderByToken = " ORDER BY ";
  const upperWiql = wiql.toUpperCase();
  const orderByIndex = upperWiql.lastIndexOf(orderByToken);
  if (orderByIndex === -1) {
    return `${wiql} AND [System.Id] > ${lastSeenId}`;
  }
  return `${wiql.slice(0, orderByIndex)} AND [System.Id] > ${lastSeenId}${wiql.slice(orderByIndex)}`;
}

// ─── Azure DevOps fetch wrapper ──────────────────────────────────────────────

async function adoFetch<T>(url: string, pat: string, options: RequestInit = {}): Promise<T> {
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      await waitForRateLimitSlot();
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: basicAuth(pat),
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(options.headers || {}),
        },
      });

      if (!res.ok) {
        const text = sanitizeForLog(await readErrorBody(res, ERROR_BODY_MAX_CHARS), pat);
        const retryable = shouldRetryStatus(res.status);
        if (retryable && attempt < MAX_FETCH_RETRIES) {
          await sleep(getRetryDelayMs(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw new ProxyError("Azure DevOps request failed", res.status, "ADO_REQUEST_FAILED", {
          retryable,
          details: text,
        });
      }
      return (await res.json()) as T;
    } catch (err: unknown) {
      const retryable = isRetryableFetchError(err);
      if (retryable && attempt < MAX_FETCH_RETRIES) {
        await sleep(getRetryDelayMs(attempt));
        continue;
      }
      if (err instanceof ProxyError) {
        throw err;
      }
      throw new ProxyError("Failed to reach Azure DevOps", 502, "NETWORK_ERROR", {
        retryable: false,
        details: sanitizeForLog(err instanceof Error ? err.message : String(err), pat),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new ProxyError("Azure DevOps request retries exhausted", 503, "RETRY_EXHAUSTED", {
    retryable: true,
  });
}

// ─── Batch fetch work item details ──────────────────────────────────────────

async function batchFetchItems(ids: number[], org: string, pat: string): Promise<WorkItem[]> {
  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    batches.push(ids.slice(i, i + BATCH_SIZE));
  }

  const results: WorkItem[] = [];
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
    const chunk = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
    const responses = await Promise.all(
      chunk.map((batch) => {
        const url = `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${batch.join(",")}&fields=${FIELDS}&api-version=${API_VERSION}`;
        return adoFetch<AdoListResponse<WorkItem>>(url, pat);
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
  const url = `https://dev.azure.com/${org}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const ids: number[] = [];
  let truncated = false;
  let lastSeenId: number | undefined;

  for (let page = 0; page < maxPages; page++) {
    const body = JSON.stringify({ query: pagedWiqlQuery(wiql, lastSeenId) });
    const data = await adoFetch<WiqlResponse>(url, pat, { method: "POST", body });
    const pageIds: number[] = (data.workItems || []).map((w) => w.id);
    if (pageIds.length === 0) {
      break;
    }
    ids = ids.concat(pageIds);

    if (pageIds.length < WIQL_PAGE_SIZE) {
      break;
    }
    lastSeenId = pageIds[pageIds.length - 1];
    if (!isPositiveInteger(lastSeenId)) {
      throw new ProxyError("Invalid work item id in WIQL response", 502, "INVALID_ADO_RESPONSE");
    }
    if (page === maxPages - 1) {
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
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_REQUEST_BODY", message: "Request body must be valid JSON" } },
      { status: 400 }
    );
  }

  if (!isRecord(body) || !isAction(body.action)) {
    return Response.json(
      { error: { code: "INVALID_ACTION", message: "Invalid or missing action" } },
      { status: 400 }
    );
  }

  const action: Action = body.action;
  let patForLog = "";

  try {
    const org = requireString(body.org, "org");
    const pat = requireString(body.pat, "PAT");
    patForLog = pat;
    const requestBody: ProxyRequestBody = {
      action,
      org,
      pat,
      project: typeof body.project === "string" ? body.project.trim() : undefined,
      team: typeof body.team === "string" ? body.team.trim() : undefined,
      epicId: typeof body.epicId === "number" ? body.epicId : undefined,
      filters: normalizeFilters(body.filters),
      maxPages: normalizeMaxPages(body.maxPages),
    };

    switch (action) {
      // ── List projects ──────────────────────────────────────────────────────
      case "fetchProjects": {
        const data = await adoFetch(
          `https://dev.azure.com/${requestBody.org}/_apis/projects?api-version=${API_VERSION}`,
          requestBody.pat
        );
        return Response.json(data);
      }

      // ── List teams ─────────────────────────────────────────────────────────
      case "fetchTeams": {
        const project = requireString(requestBody.project, "project");
        const data = await adoFetch(
          `https://dev.azure.com/${requestBody.org}/${project}/_apis/projects/${project}/teams?api-version=${API_VERSION}`,
          requestBody.pat
        );
        return Response.json(data);
      }

      // ── Team area paths ────────────────────────────────────────────────────
      case "fetchTeamAreaPaths": {
        const project = requireString(requestBody.project, "project");
        const team = requireString(requestBody.team, "team");
        const data = await adoFetch(
          `https://dev.azure.com/${requestBody.org}/${project}/${team}/_apis/work/teamsettings/teamfieldvalues?api-version=${API_VERSION}`,
          requestBody.pat
        );
        return Response.json(data);
      }

      // ── Fetch iterations (sprint schedules) ───────────────────────────────
      case "fetchIterations": {
        const project = requireString(requestBody.project, "project");
        const team = requireString(requestBody.team, "team");
        const data = await adoFetch(
          `https://dev.azure.com/${requestBody.org}/${project}/${team}/_apis/work/teamsettings/iterations?api-version=${API_VERSION}`,
          requestBody.pat
        );
        return Response.json(data);
      }

      // ── Main work item fetch (WIQL + batch) ───────────────────────────────
      case "fetchWorkItems": {
        const project = requireString(requestBody.project, "project");
        const {
          areaPath,
          iterationPath,
          createdFrom,
          createdTo,
          teamAreaPaths,
        } = requestBody.filters || {};

        let whereClause = `[System.TeamProject] = '${escapeWiqlString(project)}'`;

        if (teamAreaPaths?.length) {
          const underClauses = teamAreaPaths
            .map((p) => `[System.AreaPath] UNDER '${escapeWiqlString(p)}'`)
            .join(" OR ");
          whereClause += ` AND (${underClauses})`;
        } else if (areaPath) {
          whereClause += ` AND [System.AreaPath] UNDER '${escapeWiqlString(areaPath)}'`;
        }

        if (iterationPath) {
          whereClause += ` AND [System.IterationPath] UNDER '${escapeWiqlString(iterationPath)}'`;
        }
        if (createdFrom) {
          whereClause += ` AND [System.CreatedDate] >= '${escapeWiqlString(createdFrom)}'`;
        }
        if (createdTo) {
          whereClause += ` AND [System.CreatedDate] <= '${escapeWiqlString(createdTo)}'`;
        }

        const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${whereClause} ORDER BY [System.Id]`;
        const { ids, truncated } = await runWiqlQuery(
          wiql,
          requestBody.org,
          requestBody.pat,
          requestBody.maxPages
        );
        const items = ids.length > 0 ? await batchFetchItems(ids, requestBody.org, requestBody.pat) : [];

        return Response.json({ items, truncated });
      }

      // ── Fetch by Epic ID (recursive tree) ─────────────────────────────────
      case "fetchByEpicId": {
        const epicId = requirePositiveInteger(requestBody.epicId, "epicId");
        const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE (SOURCE.[System.Id] = ${epicId}) MODE (Recursive) ORDER BY [System.Id]`;
        const url = `https://dev.azure.com/${requestBody.org}/_apis/wit/wiql?api-version=${API_VERSION}`;
        const data = await adoFetch<WorkItemLinksResponse>(url, requestBody.pat, {
          method: "POST",
          body: JSON.stringify({ query: wiql }),
        });

        const ids: number[] = [
          ...new Set(
            (data.workItemRelations || [])
              .flatMap((r) => [r.source?.id, r.target?.id].filter(isPositiveInteger))
          ),
        ];

        const items = ids.length > 0 ? await batchFetchItems(ids, requestBody.org, requestBody.pat) : [];
        return Response.json({ items, truncated: false });
      }

      default:
        return Response.json(
          { error: { code: "INVALID_ACTION", message: `Unknown action: ${action}` } },
          { status: 400 }
        );
    }
  } catch (err: unknown) {
    const proxyError =
      err instanceof ProxyError
        ? err
        : new ProxyError("Internal server error", 500, "INTERNAL_ERROR", {
            details: err instanceof Error ? err.message : String(err),
          });
    console.error(
      `[azdevopsProxy] Error in action '${action}' (${proxyError.code}):`,
      sanitizeForLog(proxyError.details || proxyError.message, patForLog)
    );
    return Response.json(
      {
        error: {
          code: proxyError.code,
          message: proxyError.message,
          retryable: proxyError.retryable,
        },
      },
      { status: proxyError.status }
    );
  }
}
