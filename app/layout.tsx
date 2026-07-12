import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Daily arXiv — Research Display",
  description: "hep-th・gr-qc・quant-ph の新着をタイトル・著者・要旨から4項目100点満点で評価するランキング",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
