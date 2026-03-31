import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";

const MIME: Record<string, string> = {
  ".pfb": "application/x-font-pfb",
  ".pfm": "application/x-font-pfm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "node_modules/pdfjs-dist/standard_fonts"),
    path.join(cwd, "frontend/node_modules/pdfjs-dist/standard_fonts"),
  ];

  for (const base of candidates) {
    const filePath = path.resolve(base, ...segments);

    // path traversal 방지
    if (!filePath.startsWith(base)) {
      return NextResponse.json({ error: "invalid path" }, { status: 400 });
    }

    try {
      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] ?? "application/octet-stream";

      return new NextResponse(content, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ error: "font file not found" }, { status: 404 });
}
