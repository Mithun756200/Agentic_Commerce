import './globals.css';

export const metadata = {
  title: 'Agentic Commerce — AI Buyer Agent',
  description: 'Real-time transparent shopping agent with deterministic safety gates, step-by-step decision tracing, and Razorpay payments.',
  keywords: 'AI agent, agentic commerce, Razorpay, decision trace, safety gate, audit trail',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%230ea5e9'/><text y='70' x='18' font-family='monospace' font-weight='bold' font-size='60' fill='%23000'>AC</text></svg>" />
      </head>
      <body>{children}</body>
    </html>
  );
}
