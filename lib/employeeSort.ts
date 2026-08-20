/**
 * Ordering + filtering for employee pickers.
 *
 * Staff are listed by the name people actually call them — the nickname when
 * there is one — but the database only knows the legal name. Sorting by
 * legal_first_name therefore produces a list that looks unsorted: "Mindy Chen"
 * is legally Yongming, so she landed after Shelly. These helpers sort by what
 * is on screen instead.
 *
 * Sorted by the *displayed* first name, then the last name.
 *
 * It used to sort by surname, which is a perfectly good order — but every
 * picker labels people "First Last", so a surname sort reads as no sort at all
 * to anyone scanning the list. Ordering by what is actually on screen is what
 * makes it look alphabetical.
 */

export type EmployeeNameParts = {
  legal_first_name?: string | null;
  legal_last_name?: string | null;
  nicknames?: string[] | string | null;
};

/** The first name shown in the UI: nickname when set, else the legal one. */
export function preferredFirstName(e: EmployeeNameParts): string {
  const nick = Array.isArray(e.nicknames) ? e.nicknames[0] : e.nicknames;
  const trimmed = (nick ?? "").trim();
  return trimmed || (e.legal_first_name ?? "").trim();
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * Sort comparator for any employee picker.
 *
 * Note for callers that show the legal first name rather than the nickname
 * (employee meetings): the order still follows the nickname, so a "Mindy" filed
 * under M reads slightly oddly there. Matching each caller's own label exactly
 * would mean passing a name function in; not worth the API for one screen.
 */
export function compareEmployeesForPicker(a: EmployeeNameParts, b: EmployeeNameParts): number {
  const first = collator.compare(preferredFirstName(a), preferredFirstName(b));
  if (first !== 0) return first;
  return collator.compare((a.legal_last_name ?? "").trim(), (b.legal_last_name ?? "").trim());
}

/**
 * Drop people who have left.
 *
 * Inactive staff belong on the Employees page — that's where they can be made
 * active again — but nowhere you're *choosing* someone, since you can't log
 * leave, book a meeting or assign work to someone who no longer works here.
 * `keepId` keeps the currently-selected person visible so an open form doesn't
 * lose its selection the moment they're deactivated.
 */
export function activeEmployeesOnly<T extends { id?: string; is_active?: boolean | null }>(
  rows: T[],
  keepId?: string | null
): T[] {
  return rows.filter((r) => r.is_active !== false || (!!keepId && r.id === keepId));
}
