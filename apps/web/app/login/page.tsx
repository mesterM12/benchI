"use client";

import { useState, useTransition } from "react";

export default function LoginPage() {
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  function signIn(form: FormData) {
    startTransition(async () => {
      const response = await fetch("/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.get("email"), password: form.get("password"), callbackURL: "/" }) });
      if (response.ok) location.href = "/";
      else setMessage("Email or password was not accepted.");
    });
  }
  return <main className="login"><form action={signIn}><a href="/">benchI</a><h1>Local account</h1><p>Sign in as a Member or Admin. Public signup is disabled.</p><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="email" required /><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required /><button disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button><output aria-live="polite">{message}</output></form></main>;
}
