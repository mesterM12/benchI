import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = { title: "Define | benchI", description: "Author versioned Eval Suites" };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
