import { redirect } from "next/navigation";

// Students mode currently has a single tab.
export default function StudentsIndex() {
  redirect("/admin/students/admissions");
}
