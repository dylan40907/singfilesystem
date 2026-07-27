/**
 * Parser for the legacy "Inquiry Log" workbook.
 *
 * The sheets are not consistent — and not even internally consistent. Three
 * column layouts appear, and the Inactive sheet mixes two of them row by row
 * (some rows were clearly pasted over from an Active sheet). So the layout is
 * detected per row rather than per sheet, and anything ambiguous is reported as
 * a warning for a human to look at instead of being silently imported wrong.
 *
 * Rows are grouped into families: the sheet repeats the whole parent row once
 * per child, so "Yao Chen" appears twice with identical notes.
 */

export type ParsedChild = {
  name: string;
  dob: string | null;
  dob_note: string | null;
  program: string | null;
  schedule: string | null;
  learned_chinese: string | null;
  previous_school: string | null;
  chinese_level: string | null;
};

export type ParsedLead = {
  sheet: string;
  rows: number[];
  status: "active" | "inactive" | "enrolled";
  campusName: string | null;
  parent_first_name: string;
  parent_last_name: string;
  phone: string | null;
  email: string | null;
  sourceName: string | null;
  staff_name: string | null;
  desired_start_date: string | null;
  desired_start_note: string | null;
  notes: string | null;
  children: ParsedChild[];
  activities: { activity_date: string | null; note: string }[];
  warnings: string[];
};

export type ParseResult = {
  leads: ParsedLead[];
  skipped: number;
  sheetSummary: { sheet: string; rows: number; leads: number }[];
};

type Layout = {
  last: number; first: number;
  campus: number | null; source: number | null;
  phone: number; email: number;
  student: number; dob: number; curriculum: number; days: number;
  desired: number; learned: number; school: number; knowledge: number;
  staff: number; notes: number; firstDateCol: number;
};

// Active sheets: campus and "how did you hear" are present.
const LAYOUT_A: Layout = {
  last: 1, first: 2, campus: 3, source: 4, phone: 5, email: 6,
  student: 7, dob: 8, curriculum: 9, days: 10, desired: 11,
  learned: 12, school: 13, knowledge: 14, staff: 15, notes: 16, firstDateCol: 17,
};

// Inactive header: no campus, no source; phone at 4, email at 6.
const LAYOUT_B: Layout = {
  last: 1, first: 2, campus: null, source: null, phone: 4, email: 6,
  student: 7, dob: 8, curriculum: 9, days: 10, desired: 11,
  learned: 12, school: 13, knowledge: 14, staff: 15, notes: 16, firstDateCol: 17,
};

// Enrolled: campus sits in an unlabelled column 3; everything after shifts left.
const LAYOUT_C: Layout = {
  last: 1, first: 2, campus: 3, source: null, phone: 4, email: 5,
  student: 6, dob: 7, curriculum: 8, days: 9, desired: 10,
  learned: 11, school: 12, knowledge: 13, staff: 14, notes: 15, firstDateCol: 16,
};

const CAMPUS_HINT = /(torrance|^pv$|palos verdes|tpv)/i;

function looksLikePhone(s: string): boolean {
  const digits = (s.match(/\d/g) ?? []).length;
  return digits >= 7 && !s.includes("@");
}

function looksLikeEmail(s: string): boolean {
  return s.includes("@");
}

/**
 * Work out this row's layout.
 *
 * The three header layouts above are only the *documented* ones — rows pasted
 * between sheets produce more variants (an extra blank column pushes phone and
 * email right by one). Enumerating them all is a losing game, but every variant
 * shares one property: from the email column onward the fields run in a fixed
 * order, one per column —
 *
 *     email → student → dob → curriculum → days → desired start →
 *     learned Chinese → previous school → knowledge → staff → notes → dates…
 *
 * so we anchor on the email column (unmistakable: it contains "@") and derive
 * the rest by offset. Phone/campus/source are then picked out of the few
 * columns to its left by what they look like rather than where they sit.
 */
function detectLayout(cells: string[], sheetDefault: Layout): Layout {
  const at = (i: number) => (cells[i] ?? "").trim();

  // 1. Anchor: the email column.
  let emailCol = -1;
  for (let c = 3; c <= 12; c++) {
    if (looksLikeEmail(at(c))) { emailCol = c; break; }
  }

  // 2. No email? Fall back to the date of birth, which sits two past it.
  if (emailCol === -1) {
    for (let c = 6; c <= 12; c++) {
      if (parseDate(at(c))) { emailCol = c - 2; break; }
    }
  }

  if (emailCol < 3) return sheetDefault;

  // 3. To the left of the email: a phone, maybe a campus, maybe a source.
  let phoneCol = -1;
  let campusCol: number | null = null;
  let sourceCol: number | null = null;
  for (let c = 3; c < emailCol; c++) {
    const v = at(c);
    if (!v) continue;
    if (phoneCol === -1 && looksLikePhone(v)) { phoneCol = c; continue; }
    if (campusCol === null && CAMPUS_HINT.test(v)) { campusCol = c; continue; }
    if (sourceCol === null) sourceCol = c;
  }

  return {
    last: 1, first: 2,
    campus: campusCol,
    source: sourceCol,
    // A row with no phone at all still needs a column to read; point it at an
    // empty one rather than at somebody else's data.
    phone: phoneCol === -1 ? 0 : phoneCol,
    email: emailCol,
    student: emailCol + 1,
    dob: emailCol + 2,
    curriculum: emailCol + 3,
    days: emailCol + 4,
    desired: emailCol + 5,
    learned: emailCol + 6,
    school: emailCol + 7,
    knowledge: emailCol + 8,
    staff: emailCol + 9,
    notes: emailCol + 10,
    firstDateCol: emailCol + 11,
  };
}

/** "2023-08-31", "8/1/2026", Excel dates → YYYY-MM-DD, else null. */
export function parseDate(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = /^(\d{1,2})[/](\d{1,2})[/](\d{2,4})/.exec(s);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return iso(y, +m[1], +m[2]);
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (!y || !mo || !d || mo > 12 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Follow-up cells begin with a date more often than not ("6/22/26 - Toured…").
 * Pull it out for the timeline; keep the whole text as the note either way.
 */
function parseActivity(raw: string, fallbackYear: number): { activity_date: string | null; note: string } {
  const s = raw.trim();
  const m = /^(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?/.exec(s);
  if (m) {
    let y = m[3] ? +m[3] : fallbackYear;
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return { activity_date: iso(y, +m[1], +m[2]), note: s };
  }
  return { activity_date: parseDate(s), note: s };
}

function familyKey(l: { parent_last_name: string; parent_first_name: string; phone: string | null; email: string | null }): string {
  const contact = (l.phone ?? "").replace(/\D/g, "") || (l.email ?? "").toLowerCase() || "";
  return `${l.parent_last_name.toLowerCase()}|${l.parent_first_name.toLowerCase()}|${contact}`;
}

export type SheetRows = { sheet: string; rows: string[][] };

/**
 * @param sheets  Each sheet's cells as 1-indexed string arrays (index 0 unused).
 */
export function parseInquiryLog(sheets: SheetRows[]): ParseResult {
  const byKey = new Map<string, ParsedLead>();
  const order: string[] = [];
  const sheetSummary: ParseResult["sheetSummary"] = [];
  let skipped = 0;

  for (const { sheet, rows } of sheets) {
    if (/^sheet\d*$/i.test(sheet)) continue; // Sheet2 is a manual tally, not leads

    const status: ParsedLead["status"] =
      /enrolled/i.test(sheet) ? "enrolled" : /inactive/i.test(sheet) ? "inactive" : "active";
    const sheetDefault =
      /enrolled/i.test(sheet) ? LAYOUT_C : /inactive/i.test(sheet) ? LAYOUT_B : LAYOUT_A;
    // Sheet name carries the campus for the two Active sheets.
    const sheetCampus = /^tpv/i.test(sheet) ? "Torrance PV" : /^nt/i.test(sheet) ? "North Torrance" : null;

    let leadsThisSheet = 0;
    let dataRows = 0;

    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r] ?? [];
      const nonEmpty = cells.filter((c) => (c ?? "").trim()).length;
      if (nonEmpty === 0) continue;
      dataRows++;

      const L = detectLayout(cells, sheetDefault);
      const at = (i: number | null) => (i === null ? "" : (cells[i] ?? "").trim());

      const last = at(L.last);
      const first = at(L.first);
      const phoneRaw = at(L.phone);
      const emailRaw = at(L.email);
      const warnings: string[] = [];

      if (!last && !first) { skipped++; continue; }

      // Guard against a mis-detected layout writing an email into `phone`.
      let phone = phoneRaw;
      let email = emailRaw;
      if (looksLikeEmail(phone) && !looksLikeEmail(email)) {
        [phone, email] = [email, phone];
        warnings.push(`Row ${r + 1}: phone/email looked swapped — corrected.`);
      }
      if (phone && !looksLikePhone(phone) && !looksLikeEmail(phone)) {
        warnings.push(`Row ${r + 1}: "${phone}" doesn't look like a phone number.`);
      }
      if (email && !looksLikeEmail(email)) {
        warnings.push(`Row ${r + 1}: "${email}" doesn't look like an email.`);
      }

      const campusRaw = at(L.campus);
      const campusName = campusRaw
        ? /north/i.test(campusRaw) && /pv|torrance\/pv/i.test(campusRaw)
          ? null // listed both campuses — needs a human decision
          : /north/i.test(campusRaw) ? "North Torrance" : "Torrance PV"
        : sheetCampus;
      if (campusRaw && !campusName) warnings.push(`Row ${r + 1}: campus is "${campusRaw}" (both) — left unset.`);

      const desiredRaw = at(L.desired);
      const desired = parseDate(desiredRaw);
      const dobRaw = at(L.dob);
      const dob = parseDate(dobRaw);

      const child: ParsedChild = {
        name: at(L.student),
        dob,
        dob_note: dob ? null : dobRaw || null,
        program: at(L.curriculum) || null,
        schedule: at(L.days) || null,
        learned_chinese: at(L.learned) || null,
        previous_school: at(L.school) || null,
        chinese_level: at(L.knowledge) || null,
      };

      const activities: ParsedLead["activities"] = [];
      const fallbackYear = new Date().getFullYear();
      for (let c = L.firstDateCol; c < cells.length; c++) {
        const v = (cells[c] ?? "").trim();
        if (v) activities.push(parseActivity(v, fallbackYear));
      }

      const draft: ParsedLead = {
        sheet,
        rows: [r + 1],
        status,
        campusName,
        parent_first_name: first,
        parent_last_name: last,
        phone: phone || null,
        email: email || null,
        sourceName: at(L.source) || null,
        staff_name: at(L.staff) || null,
        desired_start_date: desired,
        desired_start_note: desired ? null : desiredRaw || null,
        notes: at(L.notes) || null,
        children: child.name || child.program || child.dob || child.dob_note ? [child] : [],
        activities,
        warnings,
      };

      // Merge sibling rows into the one family.
      const key = `${sheet}::${familyKey(draft)}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.rows.push(r + 1);
        // Sibling rows repeat the same child. A row with neither an email nor a
        // readable DOB can't be anchored, so its fields land a column out —
        // keep the copy that parsed rather than importing both.
        for (const c of draft.children) {
          const dupe = existing.children.some(
            (x) => x.name && c.name && x.name.toLowerCase() === c.name.toLowerCase()
          );
          const anonymousExtra = !c.name && existing.children.some((x) => !!x.name);
          if (!dupe && !anonymousExtra) existing.children.push(c);
        }
        existing.warnings.push(...draft.warnings);
        // The sheet repeats identical follow-up text on sibling rows; keep one copy.
        for (const a of draft.activities) {
          if (!existing.activities.some((x) => x.note === a.note)) existing.activities.push(a);
        }
        if (!existing.notes && draft.notes) existing.notes = draft.notes;
        if (!existing.campusName && draft.campusName) existing.campusName = draft.campusName;
        if (!existing.sourceName && draft.sourceName) existing.sourceName = draft.sourceName;
      } else {
        byKey.set(key, draft);
        order.push(key);
        leadsThisSheet++;
      }
    }

    sheetSummary.push({ sheet, rows: dataRows, leads: leadsThisSheet });
  }

  return { leads: order.map((k) => byKey.get(k)!), skipped, sheetSummary };
}

/** Map the sheet's free-text source onto the canonical source list. */
export function normalizeSourceName(raw: string | null): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("google")) return "Google";
  if (s.includes("yelp")) return "Yelp";
  if (s.includes("friend") || s.includes("word")) return "Word of Mouth";
  if (s.includes("drive")) return "Drive By";
  if (s.includes("fair")) return "Local Fair";
  if (s.includes("facebook") || s.includes("instagram") || s.includes("social") || s.includes("wechat")) return "Social Media";
  if (s.includes("sibling") || s.includes("return")) return "Sibling / Returning Family";
  if (s.includes("know")) return "Don't Know";
  return "Other";
}
