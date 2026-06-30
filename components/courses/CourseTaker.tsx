"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CourseObject, CourseProgress, FullCourse, QuizQuestion, saveProgress,
} from "@/lib/courses";

/** Renders an assigned course for an employee and tracks completion/progress. */
export default function CourseTaker({
  assignmentId,
  full,
  initialProgress,
  onClose,
  onCompletedChange,
}: {
  assignmentId: string;
  full: FullCourse;
  initialProgress: CourseProgress;
  onClose: () => void;
  onCompletedChange?: () => void;
}) {
  const orderedObjects = useMemo(() => {
    const secOrder = [...full.sections].sort((a, b) => a.position - b.position);
    const out: CourseObject[] = [];
    for (const s of secOrder) {
      out.push(...full.objects.filter((o) => o.section_id === s.id).sort((a, b) => a.position - b.position));
    }
    return out;
  }, [full]);

  const [done, setDone] = useState<Set<string>>(new Set(initialProgress.completedObjectIds ?? []));
  const [quizResults, setQuizResults] = useState<CourseProgress["quizResults"]>(initialProgress.quizResults ?? {});
  const persisted = useRef(false);

  const allComplete = orderedObjects.length > 0 && orderedObjects.every((o) => done.has(o.id));

  // Persist whenever progress changes (status derived from completion).
  useEffect(() => {
    const status = allComplete ? "completed" : done.size > 0 ? "in_progress" : "in_progress";
    const progress: CourseProgress = { completedObjectIds: Array.from(done), quizResults, lastObjectId: null };
    saveProgress(assignmentId, progress, allComplete ? "completed" : "in_progress").catch(() => {});
    if (allComplete && !persisted.current) { persisted.current = true; onCompletedChange?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, quizResults]);

  function markDone(id: string) { setDone((s) => new Set(s).add(id)); }

  const completedCount = orderedObjects.filter((o) => done.has(o.id)).length;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 12px" }}>
      <div className="card" style={{ width: "100%", maxWidth: 760, margin: "0 auto" }}>
        <div className="row-between" style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 20 }}>{full.course.title}</div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {/* Progress bar */}
        <div style={{ height: 8, background: "#f1f5f9", borderRadius: 999, overflow: "hidden", marginBottom: 4 }}>
          <div style={{ width: `${Math.round((completedCount / Math.max(1, orderedObjects.length)) * 100)}%`, height: "100%", background: "#16a34a", transition: "width .2s" }} />
        </div>
        <div className="subtle" style={{ fontSize: 12, marginBottom: 16 }}>{completedCount} / {orderedObjects.length} complete{allComplete ? " — 🎉 course completed!" : ""}</div>

        {[...full.sections].sort((a, b) => a.position - b.position).map((s) => {
          const objs = full.objects.filter((o) => o.section_id === s.id).sort((a, b) => a.position - b.position);
          if (objs.length === 0) return null;
          return (
            <div key={s.id} style={{ marginBottom: 18 }}>
              {s.title && <div style={{ fontWeight: 800, fontSize: 15, margin: "6px 0 10px" }}>📖 {s.title}</div>}
              {objs.map((o) => (
                <ObjectView key={o.id} o={o} done={done.has(o.id)}
                  result={quizResults?.[o.id]}
                  onDone={() => markDone(o.id)}
                  onQuiz={(score, passed, answers) => {
                    setQuizResults((qr) => ({ ...(qr ?? {}), [o.id]: { score, passed, answers } }));
                    if (passed) markDone(o.id);
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ObjectView({ o, done, result, onDone, onQuiz }: {
  o: CourseObject;
  done: boolean;
  result?: { score: number; passed: boolean };
  onDone: () => void;
  onQuiz: (score: number, passed: boolean, answers: Record<string, string[]>) => void;
}) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, marginBottom: 10, background: done ? "#f0fdf4" : "white" }}>
      <div className="row-between" style={{ marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>{o.title}</div>
        {done && <span style={{ color: "#16a34a", fontWeight: 800, fontSize: 13 }}>✓ Done</span>}
      </div>
      {o.type === "text" && <TextView o={o} done={done} onDone={onDone} />}
      {o.type === "image" && <MediaView><img src={o.content.url} alt={o.content.caption ?? ""} style={{ maxWidth: "100%", borderRadius: 8 }} />{o.content.caption && <div className="subtle" style={{ fontSize: 12 }}>{o.content.caption}</div>}<DoneBtn done={done} onDone={onDone} /></MediaView>}
      {o.type === "video" && <MediaView><video src={o.content.url} controls style={{ width: "100%", borderRadius: 8 }} /><DoneBtn done={done} onDone={onDone} /></MediaView>}
      {o.type === "audio" && <MediaView><audio src={o.content.url} controls style={{ width: "100%" }} /><DoneBtn done={done} onDone={onDone} /></MediaView>}
      {o.type === "pdf" && <MediaView><iframe src={o.content.url} style={{ width: "100%", height: 480, border: "1px solid #e5e7eb", borderRadius: 8 }} /><DoneBtn done={done} onDone={onDone} /></MediaView>}
      {o.type === "youtube" && <MediaView><div style={{ position: "relative", paddingBottom: "56%", height: 0 }}><iframe src={youtubeEmbed(o.content.url)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", borderRadius: 8 }} allowFullScreen /></div><DoneBtn done={done} onDone={onDone} /></MediaView>}
      {o.type === "file" && <MediaView><a className="btn" href={o.content.url} download={o.content.name} target="_blank" rel="noopener noreferrer">⬇ Download {o.content.name ?? "file"}</a><DoneBtn done={done} onDone={onDone} /></MediaView>}
      {o.type === "link" && <MediaView><a className="btn" href={o.content.url} target="_blank" rel="noopener noreferrer">🔗 Open link</a><DoneBtn done={done} onDone={onDone} /></MediaView>}
      {o.type === "quiz" && <QuizView o={o} done={done} result={result} onQuiz={onQuiz} />}
    </div>
  );
}

function MediaView({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gap: 10 }}>{children}</div>;
}

function DoneBtn({ done, onDone, label }: { done: boolean; onDone: () => void; label?: string }) {
  if (done) return null;
  return <button className="btn btn-primary" style={{ justifySelf: "flex-start" }} onClick={onDone}>{label ?? "Mark as complete"}</button>;
}

function TextView({ o, done, onDone }: { o: CourseObject; done: boolean; onDone: () => void }) {
  const requireScroll = !!o.settings.requireScroll;
  const confirmLabel = o.settings.confirmLabel as string | null | undefined;
  const allowCopy = o.settings.allowCopy !== false;
  const [scrolled, setScrolled] = useState(!requireScroll);
  const ref = useRef<HTMLDivElement | null>(null);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    if (el.scrollHeight - (el.scrollTop + el.clientHeight) < 40) setScrolled(true);
  }

  return (
    <div>
      <div
        ref={ref}
        onScroll={requireScroll ? onScroll : undefined}
        onCopy={allowCopy ? undefined : (e) => e.preventDefault()}
        style={{ maxHeight: requireScroll ? 320 : undefined, overflowY: requireScroll ? "auto" : "visible", fontSize: 14, lineHeight: 1.6, userSelect: allowCopy ? "text" : "none" }}
        dangerouslySetInnerHTML={{ __html: o.content.html ?? "" }}
      />
      {!done && (
        <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={requireScroll && !scrolled} onClick={onDone}>
          {requireScroll && !scrolled ? "Scroll to the bottom" : confirmLabel || "Mark as complete"}
        </button>
      )}
    </div>
  );
}

function QuizView({ o, done, result, onQuiz }: {
  o: CourseObject; done: boolean; result?: { score: number; passed: boolean };
  onQuiz: (score: number, passed: boolean, answers: Record<string, string[]>) => void;
}) {
  const questions = useMemo(() => {
    const qs = (o.content.questions ?? []) as QuizQuestion[];
    return o.settings.randomize ? [...qs].sort(() => Math.random() - 0.5) : qs;
  }, [o]);
  const passScore = (o.settings.passScore ?? 100) as number;
  const showCorrect = o.settings.showCorrect !== false;
  const showScore = o.settings.showScore !== false;

  const [picked, setPicked] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState<{ score: number; passed: boolean } | null>(result ?? null);

  function submit() {
    let correct = 0;
    const answers: Record<string, string[]> = {};
    for (const q of questions) {
      const chosen = picked[q.id];
      answers[q.id] = chosen ? [chosen] : [];
      const correctAns = q.answers.find((a) => a.correct);
      if (chosen && correctAns && chosen === correctAns.id) correct++;
    }
    const score = Math.round((correct / Math.max(1, questions.length)) * 100);
    const passed = score >= passScore;
    setSubmitted({ score, passed });
    onQuiz(score, passed, answers);
  }

  const allAnswered = questions.every((q) => picked[q.id]);

  if (done || submitted?.passed) {
    return <div style={{ color: "#16a34a", fontWeight: 700 }}>{showScore && submitted ? `Passed — ${submitted.score}/100` : "Passed ✓"}</div>;
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {questions.map((q, qi) => {
        const correctId = q.answers.find((a) => a.correct)?.id;
        return (
          <div key={q.id}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{qi + 1}. {q.prompt}</div>
            {q.attachmentUrl && <img src={q.attachmentUrl} alt="" style={{ maxWidth: "100%", borderRadius: 8, marginBottom: 6 }} />}
            <div style={{ display: "grid", gap: 6 }}>
              {q.answers.map((a) => {
                const isPicked = picked[q.id] === a.id;
                const reveal = submitted && showCorrect;
                const bg = reveal && a.id === correctId ? "#dcfce7" : reveal && isPicked && a.id !== correctId ? "#fee2e2" : isPicked ? "#eff6ff" : "white";
                return (
                  <label key={a.id} className="row" style={{ gap: 8, alignItems: "center", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", background: bg, cursor: "pointer" }}>
                    <input type="radio" name={q.id} checked={isPicked} disabled={!!submitted} onChange={() => setPicked((p) => ({ ...p, [q.id]: a.id }))} />
                    <span>{a.text}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      {submitted && !submitted.passed ? (
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <span style={{ color: "#991b1b", fontWeight: 700 }}>{showScore ? `Score ${submitted.score}/100 — need ${passScore}.` : "Not passed."}</span>
          <button className="btn" onClick={() => { setSubmitted(null); setPicked({}); }}>Try again</button>
        </div>
      ) : (
        <button className="btn btn-primary" style={{ justifySelf: "flex-start" }} disabled={!allAnswered} onClick={submit}>Submit quiz</button>
      )}
    </div>
  );
}

function youtubeEmbed(url: string): string {
  const m = (url || "").match(/(?:youtu\.be\/|v=|embed\/)([\w-]{6,})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : url;
}
