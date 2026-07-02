// Public-facing Employee Privacy Notice for the SING HR app. Kept in sync with
// the in-app copy (SingHRApp lib/privacyText.ts). Static page, no auth.

export const metadata = {
  title: "Employee Privacy Notice — Sing in Chinese",
  description: "Employee Privacy Notice for the SING HR app.",
};

const EFFECTIVE_DATE = "June 26, 2026";

const SECTIONS: { heading: string; body: string }[] = [
  {
    heading: "Purpose of This Notice",
    body: `Sing in Chinese collects and maintains certain employee information and employment-related documents as part of our hiring, payroll, licensing, compliance, and employment recordkeeping responsibilities. This notice explains what information we collect, why we collect it, who may access it, what vendors or systems may be used, how long we keep the information, how employees may request access, correction, or deletion, and how we protect the information.

We are committed to handling employee information carefully, respectfully, and only for legitimate business, employment, licensing, payroll, tax, and legal compliance purposes.`,
  },
  {
    heading: "Information We Collect",
    body: `Depending on the employee's position, employment status, and licensing requirements, we may collect and maintain the following categories of information and documents, including but not limited to:

• Employee signatures and signed acknowledgments
• Employment applications, employment contracts, and related hiring documents
• Social Security number
• Date of birth and other identifying information when required for employment, payroll, licensing, or background-check purposes
• Driver's license or other government-issued identification
• Green card, visa, passport, Employment Authorization Card, or other work-authorization documents, when applicable
• USCIS Form I-9 and supporting employment eligibility documents
• Bank direct deposit information
• Tax withholding forms and payroll-related information
• ECE transcripts and educational qualification documents
• Live Scan/background-check related documents, including LIC 9163
• Licensing and employment-related forms, including LIC 503, LIC 501, LIC 9095, LIC 508, LIC 9108, and LIC 9052
• Health and immunization-related records required for employment or licensing purposes, including TB clearance, MMR, Tdap, and flu shot documentation
• DMV Employer Pull Notice records, when applicable to the employee's role

We collect only the information we believe is reasonably necessary for employment, payroll, tax, licensing, background check, health and safety, or legal compliance purposes.`,
  },
  {
    heading: "Why We Collect This Information",
    body: `We collect and use employee information for the following purposes:

• To complete the hiring and onboarding process
• To verify identity and employment eligibility
• To comply with federal and state employment, tax, payroll, and immigration requirements
• To process payroll, tax withholding, and direct deposit
• To meet California child care licensing and preschool staffing requirements
• To verify educational qualifications, ECE units, and role eligibility
• To complete required background checks, Live Scan, and related licensing documentation
• To maintain required employee personnel, health, and immunization records
• To comply with DMV Employer Pull Notice requirements, when applicable
• To manage employment contracts, schedules, job duties, and workplace policies
• To respond to lawful requests from licensing agencies, government agencies, auditors, or legal authorities
• To protect the health, safety, and legal interests of employees, children, families, and the school

We do not collect employee information for unrelated purposes.`,
  },
  {
    heading: "Who May Access Employee Information",
    body: `Access to employee information is limited to authorized individuals who need the information for legitimate business, employment, payroll, licensing, system administration, or legal compliance purposes. Access may be limited based on each person's role and job duties. This may include:

• The school owner/director or authorized administrator
• Authorized payroll or HR personnel
• Authorized management staff when access is necessary for employment or licensing purposes
• Government or licensing agencies when disclosure is legally required or reasonably necessary for compliance
• Legal, accounting, payroll, or compliance professionals if needed to assist the school with legal, tax, payroll, or regulatory obligations
• Authorized technical personnel or service providers only when necessary to maintain, secure, or support the systems used to store employee records

Employees' sensitive personal information is not shared with staff members who do not have a legitimate need to access it.`,
  },
  {
    heading: "Vendors and Technology Providers",
    body: `We currently use Supabase, Cloudflare R2, Vercel, and Expo as part of our software system to help host, store, manage, process, and secure certain employee records and employment-related documents. We may also use the Apple App Store and Google Play Store to distribute applications used to access our system.

Service providers are not authorized to use employee information for their own marketing or unrelated purposes.

We may also use additional reputable technology providers in the future to host, store, back up, secure, process, or support employee information and employment-related documents. These providers may include, but are not limited to:

• Amazon Web Services (AWS)
• Google Cloud
• Microsoft, Google Workspace, or similar business productivity platforms
• Payroll, accounting, HR, compliance, or document-management systems
• Secure email, storage, backup, authentication, or cybersecurity service providers
• Other technology vendors reasonably necessary to support our employment, payroll, licensing, compliance, security, or business operations

We do not sell employee personal information. We do not share employee personal information with vendors for marketing purposes.`,
  },
  {
    heading: "How Long We Keep Employee Information",
    body: `We retain employee records for as long as reasonably necessary to meet employment, payroll, tax, licensing, legal, safety, and operational requirements. Because different records are subject to different retention rules, retention periods may vary.

In general, personnel, licensing, health/immunization, and employment records will be retained during employment and for at least four years after employment ends, unless a longer period is required by law, licensing rules, audit, investigation, dispute, insurance, or business need.

Employment tax and payroll records will generally be retained for at least four years after the applicable tax due date or payment date, whichever is later.

Form I-9 records will be retained for three years after the date of hire or one year after employment ends, whichever is later.

When records are no longer needed and are not required to be kept, we will securely delete, shred, or otherwise dispose of them in a manner intended to protect confidentiality.`,
  },
  {
    heading: "Employee Access, Correction, or Deletion Requests",
    body: `Employees may request to review or receive a copy of their own employment records as permitted by California and federal law. Employees may also request that incorrect or outdated information be corrected.

If an employee believes that a document or record is inaccurate, incomplete, or outdated, the employee should notify the school in writing and provide the corrected information or updated document.

Employees may request correction or deletion of certain records; however, the school may deny or limit deletion requests when records must be retained for employment, payroll, tax, licensing, immigration, legal, audit, insurance, investigation, or compliance purposes.

Requests may be submitted to:
Sing in Chinese Administration
APP@SingInChinese.com
310-957-2258

We will review and respond to records requests within a reasonable time and in accordance with applicable law.`,
  },
  {
    heading: "How We Protect Employee Information",
    body: `We take reasonable steps to protect employee information from unauthorized access, disclosure, loss, misuse, or improper alteration. Our safeguards may include:

• Limiting access to employee records to authorized personnel only
• Keeping physical documents in secure or restricted areas
• Using password-protected systems or devices when storing electronic records
• Using secure technology platforms to store and manage electronic records
• Using multi-factor authentication for administrator accounts where available
• Using role-based access controls to limit access based on job duties
• Maintaining audit logs of access, uploads, downloads, edits, or deletions where technically available
• Using encryption in transit and at rest where available
• Securely deleting digital files when they are no longer needed
• Limiting access to sensitive documents such as Social Security numbers, identity documents, I-9 records, tax forms, bank information, and health/immunization records

If we become aware of a security incident involving employee information, we will investigate and take appropriate steps, including providing notice when required by applicable law.

Employees should help protect their own information by submitting documents only through approved methods and promptly notifying the school if they believe their information has been sent to the wrong person or accessed improperly.`,
  },
  {
    heading: "Confidentiality",
    body: `Employee records and personal information are confidential. We do not sell employee personal information. We do not share employee personal information for marketing purposes. We use employee information only for legitimate employment, payroll, licensing, tax, legal, safety, system administration, and compliance purposes.`,
  },
  {
    heading: "Questions",
    body: `Employees who have questions about this notice or about how their information is handled may contact school administration at APP@SingInChinese.com or 310-957-2258.

This notice may be updated from time to time to reflect changes in our practices, legal requirements, technology providers, or recordkeeping procedures.`,
  },
];

export default function HrPrivacyPage() {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "48px 20px 80px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#111827",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>Employee Privacy Notice</h1>
      <p style={{ color: "#6b7280", marginTop: 6 }}>Sing in Chinese · Effective {EFFECTIVE_DATE}</p>

      {SECTIONS.map((s, i) => (
        <section key={i} style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>{s.heading}</h2>
          <p style={{ whiteSpace: "pre-wrap", color: "#374151", marginTop: 6 }}>{s.body}</p>
        </section>
      ))}
    </main>
  );
}
