# RAG Status Logic

## Overview

Every work item is assigned a RAG (Red / Amber / Green / Grey) status. The calculation follows a deterministic priority chain.

## Step 1 — Is the item complete?

An item is **complete** if:
- `System.State` is one of: `Closed`, `Done`, `Resolved`, `Removed`, `Completed`
- OR: `totalEstimate > 0` AND `totalRemaining === 0`

## Step 2 — Assign RAG colour

| Status Badge      | Complete? | Condition                                                        |
|-------------------|-----------|------------------------------------------------------------------|
| ✅ Delivered on time | Yes    | No deadline set OR deadline is today or in the future            |
| 🔴 Delivered late    | Yes    | Deadline has already passed                                      |
| ⚫ No deadline       | No     | No deadline — cannot assess health                               |
| 🔴 Past deadline     | No     | Deadline has already passed                                      |
| 🟢 On track          | No     | Deadline in future; `gap >= -0.10`                               |
| 🟡 At risk           | No     | Deadline in future; `-0.25 <= gap < -0.10`                       |
| 🔴 Behind schedule   | No     | Deadline in future; `gap < -0.25`                                |

## Progress Calculation

```
timeProgress = clamp((today − startDate) / (deadline − startDate), 0, 1)
workProgress = (totalEstimate − totalRemaining) / totalEstimate
gap          = workProgress − timeProgress
```

### Edge cases

| Situation                         | Behaviour                                               |
|-----------------------------------|---------------------------------------------------------|
| Start date missing or after today | `timeProgress = 0` → item stays Green until deadline    |
| `totalEstimate = 0`               | `workProgress = 0` → Red after deadline, Grey before it |

## On-Time Delivery for Completed Items

For completed PBIs, `System.ChangedDate` (last modified timestamp) is compared against the deadline:

- **Green** (On time): `ChangedDate <= deadline`
- **Red** (Late): `ChangedDate > deadline`

`ChangedDate` is shown in the **State Change Date** column and included in CSV exports.
