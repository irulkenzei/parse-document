// ============================================================
// parse-document
// ------------------------------------------------------------
// Menerima referensi file EPUB/DOCX yang sudah di-upload ke Appwrite
// Storage, men-download-nya, parse strukturnya jadi per-bab, lalu simpan
// hasilnya ke collection `documents` (induk/buku) dan `document_chapters`
// (per-bab).
//
// - EPUB: format ZIP berisi file-file XHTML per-bab dengan urutan bacaan
//   (spine) yang SUDAH didefinisikan di dalam strukturnya sendiri -- jadi
//   "bab" langsung ikut struktur EPUB-nya, tidak perlu heuristik.
// - DOCX: TIDAK punya konsep "bab" bawaan seperti EPUB. Deteksi bab di sini
//   dilakukan dengan convert DOCX ke HTML (pakai mammoth, yang otomatis
//   memetakan style "Heading 1" ke tag <h1>), lalu pecah per <h1>. Kalau
//   dokumen sama sekali tidak punya Heading 1 (tidak terstruktur), seluruh
//   isi dokumen diperlakukan sebagai SATU bab saja.
// - PDF: belum didukung -- PDF tidak punya struktur bab/heading yang bisa
//   diandalkan sama sekali tanpa heuristik yang jauh lebih rumit (deteksi
//   ukuran font, dsb), jadi sengaja belum dikerjakan di versi ini.
//
// Body request (JSON): {
//   "userId": "...",
//   "fileId": "...",       // file ID di Appwrite Storage
//   "bucketId": "...",     // bucket ID tempat file itu di-upload
//   "fileName": "buku.epub"  // atau "buku.docx"
// }
// Response: { success, bookId, title, chapters: [{ id, index, title, charCount }] }
// ============================================================

import { Client, Databases, ID, Storage } from 'node-appwrite';
import { EPub } from 'epub2';
import mammoth from 'mammoth';
import { convert } from 'html-to-text';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Batas aman panjang teks per-bab yang disimpan ke satu attribute Appwrite.
const MAX_CHAPTER_TEXT_LENGTH = 100000;

// Format yang didukung sejauh ini. Tambah PDF di sini nanti kalau parser-nya
// sudah dikerjakan.
const SUPPORTED_FORMATS = ['epub', 'docx'];

/**
 * Parse EPUB -> { title, chapters: [{ title, text }] }
 * "Bab" langsung ikut struktur spine (epub.flow) bawaan EPUB itu sendiri.
 */
async function parseEpub(tempFilePath, fileName, log) {
  log('Parsing EPUB structure...');
  const epub = await new Promise((resolve, reject) => {
    const e = new EPub(tempFilePath);
    e.on('end', () => resolve(e));
    e.on('error', (err) => reject(err));
    e.parse();
  });

  const title = epub.metadata?.title || fileName || 'Untitled Book';
  const chapters = [];

  for (let i = 0; i < epub.flow.length; i++) {
    const item = epub.flow[i];

    const html = await new Promise((resolve, reject) => {
      epub.getChapter(item.id, (err, text) => {
        if (err) reject(err);
        else resolve(text);
      });
    });

    // HTML dikonversi ke plain text pakai html-to-text (bukan strip tag
    // mentah), supaya paragraf/baris baru tetap masuk akal buat TTS nanti.
    const text = convert(html || '', {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
      ],
    }).trim();

    // Lewati bab kosong (biasanya halaman sampul/copyright tanpa teks).
    if (!text) continue;

    chapters.push({
      title: item.title || `Chapter ${chapters.length + 1}`,
      text,
    });
  }

  return { title, chapters };
}

/**
 * Parse DOCX -> { title, chapters: [{ title, text }] }
 * Deteksi bab dari heading "Heading 1" (mammoth otomatis memetakannya ke
 * tag <h1> di HTML hasil konversi). Kalau tidak ada <h1> sama sekali,
 * seluruh dokumen jadi SATU bab.
 */
async function parseDocx(tempFilePath, fileName, log) {
  log('Converting DOCX to HTML...');
  const { value: html } = await mammoth.convertToHtml({ path: tempFilePath });

  const title = String(fileName || 'Untitled Book').replace(/\.docx$/i, '');

  // Pecah HTML jadi potongan per <h1>...</h1> -- setiap potongan setelah
  // tag <h1> pertama dianggap 1 bab, dengan judul bab = isi teks <h1> itu.
  const h1SplitPattern = /<h1[^>]*>(.*?)<\/h1>/gi;
  const matches = [...html.matchAll(h1SplitPattern)];

  const chapters = [];

  if (matches.length === 0) {
    // Tidak ada heading sama sekali -- seluruh dokumen jadi 1 bab.
    log('No Heading 1 found in DOCX -- treating entire document as a single chapter.');
    const text = convert(html, { wordwrap: false }).trim();
    if (text) {
      chapters.push({ title: 'Chapter 1', text });
    }
  } else {
    for (let i = 0; i < matches.length; i++) {
      const currentMatch = matches[i];
      const nextMatch = matches[i + 1];

      const chapterTitleRaw = currentMatch[1].replace(/<[^>]+>/g, '').trim();
      const chapterTitle = chapterTitleRaw || `Chapter ${chapters.length + 1}`;

      const startIndex = currentMatch.index + currentMatch[0].length;
      const endIndex = nextMatch ? nextMatch.index : html.length;
      const chapterHtml = html.substring(startIndex, endIndex);

      const text = convert(chapterHtml, { wordwrap: false }).trim();
      if (!text) continue; // lewati bab yang isinya cuma judul tanpa teks

      chapters.push({ title: chapterTitle, text });
    }
  }

  return { title, chapters };
}

export default async ({ req, res, log, error }) => {
  log('parse-document function started');

  let tempFilePath = null;

  try {
    const payload = req.body
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)
      : {};
    const { userId, fileId, bucketId, fileName } = payload;

    if (!userId || !fileId || !bucketId) {
      return res.json({ success: false, error: 'userId, fileId, and bucketId are required' }, 400);
    }

    const ext = String(fileName || '').split('.').pop()?.toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext)) {
      // PDF belum didukung di versi ini -- parser-nya (dengan heuristik
      // deteksi bab yang lebih rumit) ditambahkan menyusul kalau diperlukan.
      return res.json({
        success: false,
        error: `Format '.${ext}' belum didukung di versi ini. Saat ini yang bisa diproses: ${SUPPORTED_FORMATS.join(', ')}.`,
      }, 400);
    }

    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const storage = new Storage(client);
    const databases = new Databases(client);

    // 1. Download file dari Appwrite Storage ke temp file lokal.
    //    epub2/mammoth butuh path file di disk, tidak bisa langsung dari
    //    buffer di memory.
    log(`Downloading .${ext} file from storage...`);
    const fileBuffer = await storage.getFileDownload(bucketId, fileId);
    tempFilePath = path.join(os.tmpdir(), `${ID.unique()}.${ext}`);
    fs.writeFileSync(tempFilePath, Buffer.from(fileBuffer));

    // 2. Parse sesuai formatnya -- masing-masing return bentuk yang sama:
    //    { title, chapters: [{ title, text }] }
    let parsed;
    if (ext === 'epub') {
      parsed = await parseEpub(tempFilePath, fileName, log);
    } else if (ext === 'docx') {
      parsed = await parseDocx(tempFilePath, fileName, log);
    }

    if (!parsed.chapters.length) {
      return res.json({
        success: false,
        error: 'No readable text found in this document.',
      }, 400);
    }

    // 3. Buat dokumen "book" (induk) di collection `documents`
    log('Creating book document: ' + parsed.title);
    const bookDoc = await databases.createDocument(
      process.env.APPWRITE_DATABASE_ID,
      'documents',
      ID.unique(),
      {
        user_id: userId,
        title: String(parsed.title).substring(0, 255),
        source_file_id: fileId,
        format: ext,
        chapter_count: parsed.chapters.length,
        status: 'parsed',
      }
    );

    // 4. Simpan tiap bab ke collection `document_chapters`
    const chapters = [];
    for (const chapter of parsed.chapters) {
      const truncatedText = chapter.text.substring(0, MAX_CHAPTER_TEXT_LENGTH);

      const chapterDoc = await databases.createDocument(
        process.env.APPWRITE_DATABASE_ID,
        'document_chapters',
        ID.unique(),
        {
          book_id: bookDoc.$id,
          chapter_index: chapters.length,
          title: String(chapter.title).substring(0, 255),
          text_content: truncatedText,
        }
      );

      chapters.push({
        id: chapterDoc.$id,
        index: chapterDoc.chapter_index,
        title: chapterDoc.title,
        charCount: chapter.text.length,
      });
    }

    log(`Parsed ${chapters.length} chapters successfully.`);

    return res.json({
      success: true,
      bookId: bookDoc.$id,
      title: parsed.title,
      chapters: chapters,
    });

  } catch (err) {
    error('CRITICAL ERROR: ' + err.message);
    if (err.stack) error('Stack trace: ' + err.stack);
    return res.json({ success: false, error: err.message }, 500);
  } finally {
    // Bersihkan temp file, apapun hasilnya (sukses atau gagal)
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupErr) {
        error('Gagal hapus temp file: ' + cleanupErr.message);
      }
    }
  }
};
