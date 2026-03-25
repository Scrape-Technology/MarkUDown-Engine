import { fetch } from "undici";
import { logger } from "../utils/logger.js";
import { getProxyAgentForUrl } from "../utils/proxy-region.js";

/**
 * Check if a URL points to a PDF file (by extension or content-type).
 */
export function isPdfUrl(url: string): boolean {
  return /\.pdf(\?.*)?$/i.test(url);
}

/**
 * Fetch and extract text from a PDF URL.
 * Uses a lightweight approach: fetch the PDF, detect text content.
 * For full PDF parsing, the Python LLM service handles OCR/extraction.
 */
export async function fetchPdfAsMarkdown(
  url: string,
  timeout: number = 60_000,
): Promise<{ markdown: string; title: string; pageCount: number }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    dispatcher: getProxyAgentForUrl(url),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`PDF fetch failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("pdf") && !isPdfUrl(url)) {
    throw new Error(`URL does not return a PDF (content-type: ${contentType})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Extract text from PDF using basic text extraction
  // PDF text is between stream/endstream markers, with text operators (Tj, TJ, ')
  const text = extractTextFromPdf(buffer);

  const filename = url.split("/").pop()?.replace(/\.pdf.*/i, "") || "Document";
  const title = filename.replace(/[-_]/g, " ");

  // Estimate page count from PDF page tree
  const pageCount = countPdfPages(buffer);

  const markdown = `# ${title}\n\n${text || "*PDF text extraction produced no readable text. The document may contain only images or scanned content.*"}`;

  logger.debug("PDF parsed", { url, textLength: text.length, pageCount });

  return { markdown, title, pageCount };
}

/**
 * Basic PDF text extraction — handles simple text-based PDFs.
 * For complex/scanned PDFs, falls through to LLM-based extraction.
 */
function extractTextFromPdf(buffer: Buffer): string {
  const content = buffer.toString("latin1");
  const textChunks: string[] = [];

  // Find all text streams and extract readable content
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(content)) !== null) {
    const streamContent = match[1];

    // Extract text from Tj operator (show text string)
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tjMatch: RegExpExecArray | null;
    while ((tjMatch = tjRegex.exec(streamContent)) !== null) {
      const decoded = decodePdfString(tjMatch[1]);
      if (decoded.trim()) textChunks.push(decoded);
    }

    // Extract text from TJ operator (show text array)
    const tjArrayRegex = /\[((?:\([^)]*\)|[^[\]])*)\]\s*TJ/g;
    let tjArrMatch: RegExpExecArray | null;
    while ((tjArrMatch = tjArrayRegex.exec(streamContent)) !== null) {
      const innerRegex = /\(([^)]*)\)/g;
      let innerMatch: RegExpExecArray | null;
      const parts: string[] = [];
      while ((innerMatch = innerRegex.exec(tjArrMatch[1])) !== null) {
        parts.push(decodePdfString(innerMatch[1]));
      }
      const line = parts.join("");
      if (line.trim()) textChunks.push(line);
    }
  }

  // Join and clean up
  return textChunks
    .join("\n")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodePdfString(str: string): string {
  // Handle basic PDF escape sequences
  return str
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function countPdfPages(buffer: Buffer): number {
  const content = buffer.toString("latin1");
  // Count /Type /Page entries (not /Pages)
  const pageMatches = content.match(/\/Type\s*\/Page[^s]/g);
  return pageMatches ? pageMatches.length : 1;
}
