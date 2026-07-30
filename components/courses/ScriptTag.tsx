import { ScriptKind, SCRIPT_LABEL } from "@/lib/courses";

/**
 * Marks which script a course is in. The Courses tab separates the two behind a
 * toggle, but Groups and Progress deliberately mix them — you assign and track
 * both — so there the two copies of a course need telling apart at a glance.
 */
export default function ScriptTag({ script, size = 11 }: { script: ScriptKind; size?: number }) {
  const simp = script === "simp";
  return (
    <span
      title={`${SCRIPT_LABEL[script]} Chinese`}
      style={{
        fontSize: size,
        fontWeight: 800,
        padding: "1px 7px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        background: simp ? "#eef2ff" : "#fdf2f8",
        color: simp ? "#3730a3" : "#9d174d",
        border: `1px solid ${simp ? "#c7d2fe" : "#fbcfe8"}`,
      }}
    >
      {simp ? "简 Simplified" : "繁 Traditional"}
    </span>
  );
}
