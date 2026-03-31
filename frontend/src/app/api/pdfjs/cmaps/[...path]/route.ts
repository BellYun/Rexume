import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "node_modules/pdfjs-dist/cmaps"),
    path.join(cwd, "frontend/node_modules/pdfjs-dist/cmaps"),
  ];

  for (const base of candidates) {
    const filePath = path.resolve(base, ...segments);

    // path traversal 방지
    if (!filePath.startsWith(base)) {
      return NextResponse.json({ error: "invalid path" }, { status: 400 });
    }

    try {
      const content = await fs.readFile(filePath);
      return new NextResponse(content, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ error: "cmap file not found" }, { status: 404 });
}
