---
name: API Response Shapes
description: Exact field names from generated Zod types; avoids .items/.running/.balance mistakes
---

GetAdminUsersResponse → `.users[]` (not .items)
GetPendingSignupsResponse → `.signups[]` (not .items)
GetStrategiesResponse → `.strategies[]` (not .items)
GetAuthLogsResponse → `.logs[]` (not .items)
GetAdminOverviewResponse → `.usersByProfile[]` (not .profileDistribution)
GetBotStatusResponse / GetUserDashboardResponse.botStatus → `.isRunning` (not .running)
GetUserDashboardResponse → `.user.accountBalance`, `.botStatus.dailyPnl`, `.botStatus.todayTrades`
GetSystemSettingsResponse → `.masterStop` (not .masterStopEnabled)
SetMasterStopBody → `{ active: boolean }` (not { enabled })
ExecuteCopyTradeBody → `{ direction, targetUserIds, riskMultiplier, forceOverrideUserIds? }` (not { userIds, forceOverride })
SaveDerivTokenBody → `{ token }` only — no `mode` field
UpdateTradingProfileBody → `{ profile: 'safe'|'pro'|'aggressive' }` (lowercase only)
ApproveSignupParams → `{ signupId }`, RejectSignupParams → `{ signupId }`, AdminDeleteUserParams → `{ userId }`
PauseStrategyParams / ReactivateStrategyParams → `{ strategyId }`
