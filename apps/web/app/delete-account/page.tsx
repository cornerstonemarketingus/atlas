import Link from "next/link";

export default function DeleteAccountHelpPage() {
  return <main className="legal-page"><Link href="/">← Atlas</Link><h1>Delete your Atlas account</h1><p>You can request deletion directly from Atlas. Sign in with the GitHub account connected to Atlas, open Account &amp; privacy, and type <strong>DELETE</strong> to confirm.</p><p><Link href="/account">Sign in and request deletion</Link></p><h2>What happens next</h2><p>The request enters a restricted operator queue. Eligible task, conversation, device, preference, subscription, usage, and account records are removed within 30 days. A minimal completion receipt may remain for security and compliance. Legally required billing records may be retained.</p><h2>Can’t sign in?</h2><p>Open a request in the <a href="https://github.com/cornerstonemarketingus/atlas/issues/new">Atlas support tracker</a>. Do not include passwords, tokens, or private repository information.</p></main>;
}
