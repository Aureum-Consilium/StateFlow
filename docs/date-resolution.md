# Date Resolution

Azure DevOps work items often have missing or partial date information. StateFlow uses a cascading fallback chain to determine the most relevant start date and deadline for each item.

## Epics & Features

| Date       | Priority (first non-null wins)                        |
|------------|-------------------------------------------------------|
| Start Date | `StartDate` → Investment Quarter start                |
| Deadline   | `TargetDate` → Investment Quarter end                 |

## PBIs & User Stories

| Date       | Priority (first non-null wins)                                      |
|------------|---------------------------------------------------------------------|
| Start Date | `FinishDate` → `TargetDate` → Sprint finish date → IQ end date      |
| Deadline   | `StartDate` → Sprint start date → IQ start date                     |

PBIs are assumed to be sprint-scoped, so iteration dates are preferred over quarter-level dates.

## Investment Quarter Derivation

The field `Custom.SynergyInvestmentQuarter` stores a value like `2025Q3`.

| Quarter | Derived Start | Derived End |
|---------|---------------|-------------|
| Q1      | Jan 1         | Mar 31      |
| Q2      | Apr 1         | Jun 30      |
| Q3      | Jul 1         | Sep 30      |
| Q4      | Oct 1         | Dec 31      |

If the field is blank or doesn't match `YYYYQn` format, no dates are derived.

## Sprint (Iteration) Date Resolution

On first data load, the dashboard fetches iteration schedules for all teams. Each iteration is mapped by its `IterationPath` to its `startDate` and `finishDate`.

If a PBI's `System.IterationPath` matches a known iteration, those dates are used as fallbacks.

If an item is in the backlog (no iteration assigned), the fallback chain moves on to Investment Quarter.
