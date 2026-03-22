# Table Columns

Click the **⊞** icon at the far left of the "Work Item" header to open the column visibility menu — check or uncheck any column to toggle it instantly without reloading data.

## Column Reference

| Column           | Source / Description                                                                 |
|------------------|--------------------------------------------------------------------------------------|
| Work Item        | Type badge, ID, state (for PBIs), and title with hierarchy indentation               |
| Team             | Derived by matching Area Path against team-owned area paths (longest prefix wins)   |
| State            | `System.State` value from Azure DevOps                                               |
| Estimate         | Rolled-up story points / effort from all descendants                                 |
| Remaining        | Rolled-up remaining work from all descendants                                        |
| Completed        | Rolled-up completed work from all descendants                                        |
| Progress         | Visual bar showing `(Estimate − Remaining) / Estimate %`, coloured by RAG status    |
| RAG              | Calculated delivery health badge (see RAG Status Logic)                              |
| Epic RAG         | `Custom.StatusGAR` — manually set Red / Amber / Green badge on the epic              |
| Epic Dev         | `Custom.Developmentstatus` — development status label set on the epic                |
| Epic Days        | `Custom.EstimatedDevDays` — estimated development days                               |
| Epic Estim       | `Microsoft.VSTS.Scheduling.Effort` — raw effort value on the epic                    |
| Created          | `System.CreatedDate` formatted as DD/MM/YYYY                                         |
| Start Date       | Resolved start date (see Date Resolution)                                            |
| Deadline         | Resolved target/deadline date (see Date Resolution)                                  |
| State Change Date| `System.ChangedDate` — last modification timestamp, used for on-time delivery        |
| Quarter          | `Custom.SynergyInvestmentQuarter` — e.g. `2025Q3`                                   |
| WBSO             | `Custom.WBSOChapter`                                                                 |
| IR               | `Custom.SynergyRequestID`                                                            |
| ProjCode         | `Custom.ExactOnlineProject`                                                          |
