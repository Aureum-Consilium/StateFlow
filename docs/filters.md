# Filters

## Server-side Filters (affect the WIQL query)

These filters are sent to Azure DevOps when data is fetched. They reduce the number of items returned from the server and **require a new data load** to take effect.

| Filter       | How it works                                                                 |
|--------------|------------------------------------------------------------------------------|
| Team         | Fetches the team's owned area paths, adds `UNDER` clause per path in WIQL. Triggers automatic reload. |
| Area Path    | Adds `[System.AreaPath] UNDER '…'` to WIQL. Requires **Fetch** or **Refresh**. |
| Iteration    | Adds `[System.IterationPath] UNDER '…'` to WIQL. Requires **Fetch** or **Refresh**. |
| Created date | Adds `[System.CreatedDate] >= … AND <= …` to WIQL. Requires clicking **Fetch**. |
| Epic ID      | Runs a recursive tree query for exactly one epic and all descendants. Independent of other filters. |

## Client-side Filters (instant, no API call)

These filters run immediately on already-loaded data.

| Filter       | How it works                                                       |
|--------------|--------------------------------------------------------------------|
| Search       | Case-insensitive substring match on title, or exact match on ID.  |
| State        | Shows only top-level items (Epics) matching the selected state.   |
| Hide closed  | Hides items with states: Closed, Done, Resolved, Removed.         |
| Deadline     | Hides top-level items with resolved TargetDate outside the range. |

## Fetch vs Refresh

### Fetch button
- Triggers a **new data load** with the current Created date range
- Sends the date range as a WIQL clause to Azure DevOps
- Also respects current Area Path, Iteration, and Team filters
- Use this after changing date inputs

### Refresh button
- Reloads data using **filters from the last successful fetch**
- Does NOT pick up changes typed into date inputs since last Fetch
- Use this to get fresh data from Azure DevOps without changing filter criteria
- Shows "Updated at" timestamp in the header after completion

> **Rule of thumb:** Changed a date filter? Click **Fetch**. Just want the latest data? Click **Refresh**.

## Pagination

- WIQL queries paginated in batches of **5,000 IDs**
- Default max: **3 pages (15,000 items)** — configurable up to 20 pages (100,000 items) via the Max pages filter
- If results are truncated, a **warning banner** appears — use filters to narrow scope
- Full item details fetched in parallel batches of **200 IDs** (up to 5 concurrent requests)
