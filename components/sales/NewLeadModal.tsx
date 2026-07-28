"use client";

import { useEffect, useState } from "react";
import type { Campus } from "@/lib/CampusContext";
import { useEscapeKey } from "@/components/ui/useEscapeKey";
import {
  FIRST_CONTACT_LABEL,
  FirstContactType,
  PREFERRED_LANGUAGES,
  PROGRAMS,
  SalesSource,
  TIME_ZONES,
  addChild,
  createLead,
  fetchAssignableStaff,
  localTimeFor,
  sourceWantsReferrer,
  todayLocal,
} from "@/lib/sales";

/**
 * Captures a new inquiry. Only the parent's name and campus are required — an
 * inquiry often arrives as a half-finished phone call, and forcing more fields
 * would just push staff back to the spreadsheet. Everything else is filled in
 * on the lead page as it's learned.
 */
export default function NewLeadModal({
  sources,
  campuses,
  defaultCampusId,
  onClose,
  onCreated,
}: {
  sources: SalesSource[];
  campuses: Campus[];
  defaultCampusId: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  // A family can be considering both campuses; whichever they pick later wins.
  const [campusIds, setCampusIds] = useState<string[]>(defaultCampusId ? [defaultCampusId] : []);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceOther, setSourceOther] = useState("");
  const [referredBy, setReferredBy] = useState("");
  const [firstContact, setFirstContact] = useState<FirstContactType | "">("");
  const [inquiryDate, setInquiryDate] = useState(todayLocal());
  const [notes, setNotes] = useState("");
  const [timeZone, setTimeZone] = useState("");
  const [language, setLanguage] = useState("");
  const [ownerId, setOwnerId] = useState("");

  const [childName, setChildName] = useState("");
  const [childDob, setChildDob] = useState("");
  const [childProgram, setChildProgram] = useState("");
  const [childProgramOther, setChildProgramOther] = useState("");
  const [childSchedule, setChildSchedule] = useState("");
  // Start dates belong to the child — siblings often start in different terms.
  const [childStart, setChildStart] = useState("");
  const [childStartNote, setChildStartNote] = useState("");

  const [staff, setStaff] = useState<{ id: string; full_name: string | null; role: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEscapeKey(onClose, !busy);

  useEffect(() => {
    (async () => {
      try { setStaff(await fetchAssignableStaff()); } catch { /* picker just stays empty */ }
    })();
  }, []);

  const selectedSourceName = sources.find((s) => s.id === sourceId)?.name ?? null;
  const otherSelected = selectedSourceName === "Other";
  const wantsReferrer = sourceWantsReferrer(selectedSourceName);

  function toggleCampus(id: string) {
    setCampusIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function submit() {
    if (!firstName.trim() && !lastName.trim()) {
      setError("Enter the parent's name.");
      return;
    }
    if (campusIds.length === 0) {
      setError("Pick at least one campus — leads with no campus are only visible to full admins.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const lead = await createLead({
        campus_ids: campusIds,
        status: "active",
        parent_first_name: firstName.trim(),
        parent_last_name: lastName.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        city: city.trim() || null,
        source_id: sourceId || null,
        source_other: otherSelected ? sourceOther.trim() || null : null,
        referred_by: wantsReferrer ? referredBy.trim() || null : null,
        first_contact_type: firstContact || null,
        inquiry_date: inquiryDate || todayLocal(),
        time_zone: timeZone || null,
        preferred_language: language || null,
        staff_owner_id: ownerId || null,
        notes: notes.trim() || null,
      });

      const program = childProgram === "Other" ? childProgramOther.trim() : childProgram;
      if (childName.trim() || program || childDob || childStart) {
        await addChild(lead.id, {
          name: childName.trim(),
          dob: childDob || null,
          program: program || null,
          schedule: childSchedule.trim() || null,
          desired_start_date: childStart || null,
          desired_start_note: childStartNote.trim() || null,
          order_index: 0,
        });
      }

      onCreated(lead.id);
    } catch (e) {
      setError((e as Error)?.message ?? "Could not create the lead.");
      setBusy(false);
    }
  }

  return (
    <div
      onMouseDown={(e) => { if (e.currentTarget === e.target && !busy) onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100,
        display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto",
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 620, marginTop: 40, marginBottom: 40 }}>
        <div className="row-between" style={{ marginBottom: 4 }}>
          <div style={{ fontWeight: 900, fontSize: 17 }}>New lead</div>
          <button className="btn" onClick={onClose} disabled={busy}>Close</button>
        </div>
        <div className="subtle" style={{ fontSize: 12, marginBottom: 8 }}>
          Only the parent name and campus are required — fill in the rest later.
        </div>

        {error ? <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>{error}</div> : null}

        <div style={grid2}>
          <div>
            <label style={lbl}>Parent first name</label>
            <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={lbl}>Parent last name</label>
            <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>Campus(es) they’re considering</label>
            <div className="row" style={{ gap: 12, flexWrap: "wrap", paddingTop: 8 }}>
              {campuses.map((c) => (
                <label key={c.id} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}>
                  <input type="checkbox" checked={campusIds.includes(c.id)} onChange={() => toggleCampus(c.id)} />
                  {c.name}
                </label>
              ))}
            </div>
            {campusIds.length > 1 && (
              <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
                Both campuses will see this lead until they choose.
              </div>
            )}
          </div>
          <div>
            <label style={lbl}>Inquiry date</label>
            <input className="input" type="date" value={inquiryDate} onChange={(e) => setInquiryDate(e.target.value)} />
          </div>
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>Phone</label>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Email</label>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>City</label>
            <input className="input" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Call or scheduled tour?</label>
            <select className="select" value={firstContact} onChange={(e) => setFirstContact(e.target.value as FirstContactType)}>
              <option value="">— Choose —</option>
              {(Object.keys(FIRST_CONTACT_LABEL) as FirstContactType[]).map((k) => (
                <option key={k} value={k}>{FIRST_CONTACT_LABEL[k]}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>How did you hear about us?</label>
            <select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">— Choose —</option>
              {sources.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {otherSelected && (
            <div>
              <label style={lbl}>Where exactly?</label>
              <input className="input" value={sourceOther} onChange={(e) => setSourceOther(e.target.value)} />
            </div>
          )}
          {wantsReferrer && (
            <div>
              <label style={lbl}>Who told them about us?</label>
              <input
                className="input"
                placeholder="Name of the family or friend"
                value={referredBy}
                onChange={(e) => setReferredBy(e.target.value)}
              />
            </div>
          )}
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>Time zone</label>
            <select className="select" value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              <option value="">— Not known —</option>
              {TIME_ZONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {timeZone && (
              <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
                It’s {localTimeFor(timeZone)} for them right now.
              </div>
            )}
          </div>
          <div>
            <label style={lbl}>Preferred language</label>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">— Not known —</option>
              {PREFERRED_LANGUAGES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>Owner</label>
            <select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">— Unassigned —</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name ?? s.id}</option>)}
            </select>
          </div>
        </div>

        <div style={{ borderTop: "1px solid #f1f5f9", margin: "16px 0 4px", paddingTop: 12, fontWeight: 800, fontSize: 13 }}>
          First child <span className="subtle" style={{ fontWeight: 500 }}>(optional — add siblings on the lead page)</span>
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>Child name</label>
            <input className="input" value={childName} onChange={(e) => setChildName(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Date of birth</label>
            <input className="input" type="date" value={childDob} onChange={(e) => setChildDob(e.target.value)} />
          </div>
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>Program</label>
            <select className="select" value={childProgram} onChange={(e) => setChildProgram(e.target.value)}>
              <option value="">— Choose —</option>
              {PROGRAMS.map((p) => <option key={p} value={p}>{p}</option>)}
              <option value="Other">Other…</option>
            </select>
          </div>
          {childProgram === "Other" && (
            <div>
              <label style={lbl}>Which program?</label>
              <input className="input" value={childProgramOther} onChange={(e) => setChildProgramOther(e.target.value)} />
            </div>
          )}
          <div>
            <label style={lbl}>Days / schedule</label>
            <input className="input" placeholder="5 Days/Week (9am - 3pm)" value={childSchedule} onChange={(e) => setChildSchedule(e.target.value)} />
          </div>
        </div>

        <div style={grid2}>
          <div>
            <label style={lbl}>Desired start date</label>
            <input className="input" type="date" value={childStart} onChange={(e) => setChildStart(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>…or in their words</label>
            <input className="input" placeholder="ASAP, July or August…" value={childStartNote} onChange={(e) => setChildStartNote(e.target.value)} />
          </div>
        </div>

        <label style={lbl}>Notes</label>
        <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything that will help prepare for the meeting…" style={{ minHeight: 80 }} />

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Creating…" : "Create lead"}
          </button>
        </div>
      </div>
    </div>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#374151", margin: "12px 0 6px" };
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 };
