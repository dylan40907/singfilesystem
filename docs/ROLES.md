# Roles and page permissions

## The rule, up front

**Adding a page? Add it to `lib/pagePermissions.ts` in the same change.**

A page missing from that file is invisible to the role editor. It won't appear
as something a role can be granted or denied, so nobody can be given access to
it and nobody can be kept out of it — it silently falls back to whatever role
checks happen to be hardcoded around it. That's exactly the mess this system
replaced.

## How it works

A role is **a base level plus per-page overrides**.

- **Base level** — `teacher`, `supervisor`, or `campus_admin`. Stored in
  `user_profiles.role`. This is what row-level security understands, and it did
  not change when custom roles were introduced, so every existing policy still
  works.
- **Overrides** — rows in `hr_role_permissions` saying a specific page is
  `none` / `view` / `edit` for that role.
- `user_profiles.hr_role_id` points at the custom role, or is null for "just the
  level's defaults".

Full admins (`role = 'admin'`) bypass all of it and always get `edit`.

### Why not just add more roles to the enum?

That's what was happening. "App Supervisor" was a supervisor plus a
`can_manage_learning` boolean column, and each new variation would have meant
another column and another special case in every nav component. Now it's data.

## Adding a page

1. Add an entry to `PAGES` in `lib/pagePermissions.ts`:
   - `key` — stable, stored in the database. **Never rename one in place**; a
     rename orphans every override pointing at the old key.
   - `editable` — `false` for genuinely read-only pages, so the editor offers
     On/Off instead of a meaningless View/Edit choice.
   - `defaults` — what each of the three levels gets when a role says nothing.
2. Gate the page itself with `canView` / `canEdit` from `lib/access.ts`.
3. If the page reads data a base level cannot normally see, **add a policy**.
   The UI grant alone will show an empty page. See the timesheets example below.

## The security boundary

`resolveAccess` decides **navigation and whether edit controls are offered**.
It is not the security boundary — RLS is.

A grant only becomes real when the database also allows it. For example,
granting a teacher `hr.timesheets: view` needs this policy, or they see an empty
page:

```sql
create policy "page grant read clock_entries"
  on public.clock_entries for select to authenticated
  using (public.has_page_access('hr.timesheets', 'view'));
```

Helpers available in SQL:

- `public.my_page_access(page_key)` → `'none' | 'view' | 'edit'`, or null when
  no override applies.
- `public.has_page_access(page_key, min)` → boolean.

Both know about **overrides only**, not base-level defaults. Defaults live in
TypeScript, and duplicating them into SQL would give two copies to keep in step.
Base-level behaviour is already governed by the existing policies that key on
`user_profiles.role`.

## Things that are deliberately not grantable

- **`hr.roles`** — whoever edits roles can grant themselves anything, so it is
  admin-only and `resolveAccess` hard-codes `none` for it regardless of any
  override.
- **Deleting the three built-in roles** — `is_system` roles can be edited but
  not deleted, since deleting the role every teacher holds would orphan them.

## Gotchas

- Deleting a custom role puts everyone holding it back on their base level's
  defaults. The UI warns with a headcount first.
- A role's `base_role` must match the level; the `admin-change-user-role` edge
  function re-checks this rather than trusting the client.
- Overrides are only stored when they **differ** from the base default, so a
  role automatically follows future changes to its level's defaults instead of
  freezing a copy of today's answer.
