const { Client, Databases, Storage, ID } = require('node-appwrite');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');

// ============================================================
// parse-document
// ------------------------------------------------------------
// Function ini KHUSUS dipakai mobile app (DocumentImportScreen.tsx) untuk
// fitur "import buku -> audiobook per-bab". Input: fileId + bucketId +
// fileName. Output: { title, chapters: [{ title, content }, ...] }.
//
// ⚠️ INI BEDA dari function "convert-document" (EPUB<->DOCX<->PDF<->TXT,
// dipakai fitur Document Converter di WEB) -- itu payload & tujuannya
// beda total (convert 1 file ke format lain, bukan pecah jadi per-bab).
// Kalau butuh lihat kode convert-document, itu ada di repo/function
// terpisah, JANGAN dicampur ke sini lagi (ini penyebab bug
// "requestId is required" yang sempat kejadian -- kode convert-document
// ke-deploy salah ke sini).
// ============================================================

function stripHtmlTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|br|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractChapterTitle(html, fallback) {
  const headingMatch = html.match(/<h[1-2][^>]*>([\s\S]*?)<\/h[1-2]>/i);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const match = headingMatch || titleMatch;
  if (match) {
    const cleaned = stripHtmlTags(match[1]).trim();
    if (cleaned) return cleaned;
  }
  return fallback;
}

// ============================================================
// EPUB -- parsing manifest/spine yang BENAR (bukan asal-asalan urut
// alfabetis file HTML dalam ZIP): baca META-INF/container.xml -> temukan
// file .opf -> baca <manifest> (peta id -> file) dan <spine> (urutan
// baca resmi) -> ekstrak SATU CHAPTER per item spine (skip item
// properties="nav" -- itu halaman navigasi EPUB3, bukan chapter beneran).
// ============================================================
function extractChaptersFromEpub(buffer) {
  const zip = new AdmZip(buffer);

  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (!containerEntry) throw new Error('Invalid EPUB: META-INF/container.xml not found');
  const containerXml = containerEntry.getData().toString('utf-8');
  const opfPathMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!opfPathMatch) throw new Error('Invalid EPUB: OPF path not found in container.xml');
  const opfPath = opfPathMatch[1];
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`Invalid EPUB: OPF file not found at ${opfPath}`);
  const opfXml = opfEntry.getData().toString('utf-8');

  // Judul buku dari metadata <dc:title>
  const bookTitleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  const bookTitle = bookTitleMatch ? stripHtmlTags(bookTitleMatch[1]).trim() : null;

  const manifest = {};
  const itemPattern = /<item\s+([^>]+)\/?>/gi;
  let match;
  while ((match = itemPattern.exec(opfXml)) !== null) {
    const attrs = match[1];
    const idMatch = attrs.match(/id="([^"]+)"/);
    const hrefMatch = attrs.match(/href="([^"]+)"/);
    const propsMatch = attrs.match(/properties="([^"]+)"/);
    if (idMatch && hrefMatch) {
      manifest[idMatch[1]] = {
        href: hrefMatch[1],
        isNav: propsMatch ? propsMatch[1].includes('nav') : false,
      };
    }
  }

  const spineIds = [];
  const spinePattern = /<itemref\s+([^>]+)\/?>/gi;
  while ((match = spinePattern.exec(opfXml)) !== null) {
    const idrefMatch = match[1].match(/idref="([^"]+)"/);
    if (idrefMatch) spineIds.push(idrefMatch[1]);
  }

  const chapters = [];
  let chapterIndex = 1;
  for (const id of spineIds) {
    const item = manifest[id];
    if (!item || item.isNav) continue;
    const fullPath = opfDir + item.href;
    const contentEntry = zip.getEntry(fullPath);
    if (!contentEntry) continue;
    const html = contentEntry.getData().toString('utf-8');
    const text = stripHtmlTags(html);
    if (!text.trim()) continue; // skip halaman kosong (misal cover cuma gambar)
    chapters.push({
      title: extractChapterTitle(html, `Chapter ${chapterIndex}`),
      content: text,
    });
    chapterIndex++;
  }

  return { title: bookTitle, chapters };
}

// ============================================================
// DOCX -- mammoth.convertToHtml (BUKAN extractRawText) supaya heading
// style ("Heading 1" di Word) ikut kebawa jadi tag <h1> di HTML hasilnya.
// Pecah per-bab di TIAP <h1> yang ketemu. Kalau dokumennya gak punya
// heading sama sekali, treat sebagai 1 chapter tunggal (lebih baik
// daripada gagal total).
// ============================================================
async function extractChaptersFromDocx(buffer) {
  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value;

  const parts = html.split(/(?=<h1[^>]*>)/i).filter((p) => p.trim());

  if (parts.length <= 1) {
    const text = stripHtmlTags(html);
    if (!text.trim()) throw new Error('No readable text found in this DOCX file.');
    return [{ title: 'Full Document', content: text }];
  }

  return parts
    .map((part, i) => {
      const titleMatch = part.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const title = titleMatch ? stripHtmlTags(titleMatch[1]).trim() || `Chapter ${i + 1}` : `Chapter ${i + 1}`;
      const content = stripHtmlTags(part.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, ''));
      return { title, content };
    })
    .filter((ch) => ch.content.trim());
}

// ============================================================
// MAIN HANDLER
// ------------------------------------------------------------
// 🔧 ARSITEKTUR: function ini dipanggil ASYNCHRONOUS (hindari limit 30
// detik synchronous execution). Karena `responseBody` dari getExecution()
// TERBUKTI SELALU KOSONG buat eksekusi async (keterbatasan resmi
// Appwrite), hasilnya ditulis LANGSUNG ke Database -- client poll
// dokumen `documents` (bukan status eksekusi) buat tau kapan selesai.
//
// Skema yang dipakai (SUDAH ADA, bukan bikin baru):
//   documents:         user_id, title, source_file_id, format,
//                       chapter_count, status
//   document_chapters: book_id (-> documents.$id), chapter_index,
//                       title, text_content
// ------------------------------------------------------------
module.exports = async ({ req, res, log, error }) => {
  const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
  const DOCUMENTS_COLLECTION_ID = 'documents';
  const CHAPTERS_COLLECTION_ID = 'document_chapters';

  let requestId;
  let databases;

  try {
    const payload = JSON.parse(req.body || '{}');
    const { requestId: reqId, fileId, bucketId, fileName } = payload;
    requestId = reqId;

    if (!requestId) return res.json({ success: false, error: 'requestId is required' }, 400);
    if (!fileId) return res.json({ success: false, error: 'fileId is required' }, 400);
    if (!bucketId) return res.json({ success: false, error: 'bucketId is required' }, 400);
    if (!fileName) return res.json({ success: false, error: 'fileName is required' }, 400);

    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);
    const storage = new Storage(client);
    databases = new Databases(client);

    log(`Parsing document "${fileName}" (fileId: ${fileId})`);

    // Download isi file dari Storage
    const fileBytes = await storage.getFileDownload(bucketId, fileId);
    const buffer = Buffer.from(fileBytes);

    const ext = fileName.toLowerCase().split('.').pop();
    let title = fileName.replace(/\.[^.]+$/, '');
    let chapters = [];

    if (ext === 'epub') {
      const result = extractChaptersFromEpub(buffer);
      if (result.title) title = result.title;
      chapters = result.chapters;
    } else if (ext === 'docx') {
      chapters = await extractChaptersFromDocx(buffer);
    } else {
      // ⚠️ Tidak ada kolom error_message di collection `documents` --
      // detail error cukup di-log() server-side (kelihatan di tab
      // Executions), status 'failed' aja yang perlu diketahui client.
      await databases.updateDocument(DATABASE_ID, DOCUMENTS_COLLECTION_ID, requestId, { status: 'failed' });
      return res.json({ success: false, error: `Unsupported file format: .${ext}` }, 400);
    }

    if (chapters.length === 0) {
      await databases.updateDocument(DATABASE_ID, DOCUMENTS_COLLECTION_ID, requestId, { status: 'failed' });
      return res.json({ success: false, error: 'No chapters could be extracted.' }, 400);
    }

    log(`Extracted ${chapters.length} chapter(s) from "${title}"`);

    // ⚠️ text_content dibatesin 100.000 karakter di skema -- kalau ada
    // chapter yang lebih panjang dari itu (buku tebal, bab gak dipecah
    // kecil-kecil), createDocument bakal REJECT baris itu. Dipotong di
    // sini SUPAYA GAK GAGAL TOTAL -- lebih baik chapter kepotong drpd
    // seluruh proses gagal. Kalau ini kejadian, chapter yang kepotong
    // logged sebagai warning biar ketauan.
    const MAX_CONTENT_SIZE = 100000;

    // Tulis tiap chapter sebagai baris terpisah di document_chapters
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      let content = ch.content;
      if (content.length > MAX_CONTENT_SIZE) {
        log(`WARNING: Chapter ${i + 1} ("${ch.title}") exceeds ${MAX_CONTENT_SIZE} chars (${content.length}), truncating.`);
        content = content.slice(0, MAX_CONTENT_SIZE);
      }
      await databases.createDocument(DATABASE_ID, CHAPTERS_COLLECTION_ID, ID.unique(), {
        book_id: requestId,
        chapter_index: i,
        title: ch.title,
        text_content: content,
      });
    }

    // ✅ Update dokumen `documents` -- INI yang di-poll client buat tau
    // kapan selesai.
    await databases.updateDocument(DATABASE_ID, DOCUMENTS_COLLECTION_ID, requestId, {
      title,
      chapter_count: chapters.length,
      status: 'completed',
    });

    return res.json({ success: true });
  } catch (err) {
    error(`Parse failed: ${err.message}`);
    if (requestId && databases) {
      try {
        await databases.updateDocument(DATABASE_ID, 'documents', requestId, { status: 'failed' });
      } catch (updateErr) {
        error(`Failed to update job status: ${updateErr.message}`);
      }
    }
    return res.json({ success: false, error: err.message }, 500);
  }
};
