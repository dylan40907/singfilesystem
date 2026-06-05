export const metadata = {
  title: "Delete Your Account · Sing in Chinese",
  description: "How to delete your Sing in Chinese Learning account and associated data.",
};

export default function DeleteAccountPage() {
  const wrap: React.CSSProperties = {
    maxWidth: 760,
    margin: "0 auto",
    padding: "40px 22px 96px",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    color: "#1f2937",
    lineHeight: 1.7,
  };

  return (
    <main style={wrap}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#e6178d", marginBottom: 28, letterSpacing: 0.2 }}>
        Sing in Chinese
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>Delete Your Account</h1>
      <p style={{ fontSize: 15.5, color: "#4b5563", marginTop: 0 }}>
        Sing in Chinese Learning · com.singinchinese.learning
      </p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 28 }}>Delete in the app</h2>
      <p>You can permanently delete your account and all associated data at any time, directly in the app:</p>
      <ol style={{ paddingLeft: 22 }}>
        <li>Open the Sing in Chinese Learning app and sign in.</li>
        <li>Go to <b>Settings</b>.</li>
        <li>Tap <b>Delete Account</b> and confirm.</li>
      </ol>
      <p>This permanently removes your account and cannot be undone.</p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 28 }}>Delete by request</h2>
      <p>
        If you can&apos;t access the app, email{" "}
        <a href="mailto:lynn@singinchinese.com" style={{ color: "#e6178d" }}>lynn@singinchinese.com</a>{" "}
        from or with the account&apos;s email address and ask us to delete your account. We will verify your request
        and remove your account and personal data.
      </p>

      <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 28 }}>What is deleted</h2>
      <p>
        Deleting your account permanently removes your personal data: your <b>name</b>, <b>email address</b>,
        <b> language preference</b>, and your account access and lesson-permission records. This data is deleted
        immediately and is not retained, except where retention is required by law.
      </p>
    </main>
  );
}
