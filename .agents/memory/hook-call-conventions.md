---
name: Hook Call Conventions (Orval generated)
description: How to pass react-query options vs URL params in Orval-generated hooks
---

Hooks with URL/query params have signature: `useHook(params?, options?)`
- params = URL path/query params
- options = `{ query: { queryKey, refetchInterval, ... } }`

When you only want query options (no params): pass `undefined` as first arg
  CORRECT: `useGetAdminUsers(undefined, { query: { queryKey: [...] } })`
  WRONG:   `useGetAdminUsers({ query: { queryKey: [...] } })`  ← TS error: query not in params type

Same pattern for useGetAuthLogs, useGetAdminUsers, etc.
Hooks with NO params (useGetAdminOverview, useGetStrategies, etc.) take options as first arg directly.

**Why:** Orval generates typed overloads; mixing params and options causes TS2353 "property does not exist" errors.
