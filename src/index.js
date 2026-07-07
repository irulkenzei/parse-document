// ============================================================
// parse-document
// ------------------------------------------------------------
// Menerima referensi file EPUB yang sudah di-upload ke Appwrite Storage,
// men-download-nya, parse strukturnya jadi per-bab, lalu simpan hasilnya
// ke collection `documents` (induk/buku) dan `document_chapters` (per-bab).
//
// Kenapa EPUB duluan (bukan PDF/DOCX): EPUB itu format ZIP berisi file-file
// XHTML per-bab dengan urutan bacaan (spine) yang SUDAH didefinisikan di
// dalam strukturnya sendiri -- jadi "bab" nggak perlu dideteksi pakai
// heuristik kayak PDF (yang nggak punya konsep bab bawaan sama sekali).
//
// Body request (JSON): {
//   "userId": "...",
//   "fileId": "...",       // file ID di Appwrite Storage (hasil upload EPUB)
//   "bucketId": "...",     // bucket ID tempat file EPUB itu di-upload
//   "fileName": "buku.epub"
// }
// Response: { success, bookId, title, chapters: [{ id, index, title, charCount }] }
// ============================================================

import { Client, Databases, ID, Storage } from 'node-appwrite';
import { EPub } from 'epub2';
import { convert } from 'html-to-text';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Batas aman panjang teks per-bab yang disimpan ke satu attribute Appwrite.
// Kalau ada bab yang lebih panjang dari ini, dipotong -- attribute string
// Appwrite ada batas maksimalnya sendiri, dan bab seharusnya jarang sepanjang
// ini (>100rb karakter kira-kira setara novel pendek dalam SATU bab).
const MAX_CHAPTER_TEXT_LENGTH = 100000;

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
    if (ext !== 'epub') {
      // DOCX & PDF belum didukung di versi ini -- parser masing-masing
      // ditambahkan menyusul sebagai cabang terpisah di sini.
      return res.json({
        success: false,
        error: `Format '.${ext}' belum didukung di versi ini. Saat ini cuma .epub yang bisa diproses.`,
      }, 400);
    }

    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const storage = new Storage(client);
    const databases = new Databases(client);

    // 1. Download file dari Appwrite Storage ke temp file lokal.
    //    epub2 butuh path file di disk, tidak bisa langsung dari buffer di memory.
    log('Downloading EPUB file from storage...');
    const fileBuffer = await storage.getFileDownload(bucketId, fileId);
    tempFilePath = path.join(os.tmpdir(), `${ID.unique()}.epub`);
    fs.writeFileSync(tempFilePath, Buffer.from(fileBuffer));

    // 2. Parse EPUB
    log('Parsing EPUB structure...');
    const epub = await new Promise((resolve, reject) => {
      const e = new EPub(tempFilePath);
      e.on('end', () => resolve(e));
      e.on('error', (err) => reject(err));
      e.parse();
    });

    const bookTitle = epub.metadata?.title || fileName || 'Untitled Book';

    // 3. Buat dokumen "book" (induk) di collection `documents`
    log('Creating book document: ' + bookTitle);
    const bookDoc = await databases.createDocument(
      process.env.APPWRITE_DATABASE_ID,
      'documents',
      ID.unique(),
      {
        user_id: userId,
        title: String(bookTitle).substring(0, 255),
        source_file_id: fileId,
        format: 'epub',
        chapter_count: epub.flow.length,
        status: 'parsed',
      }
    );

    // 4. Ekstrak tiap bab (epub.flow = urutan bacaan/spine sesuai struktur
    //    EPUB itu sendiri), simpan ke collection `document_chapters`.
    //    HTML dikonversi ke plain text pakai html-to-text (bukan strip tag
    //    mentah pakai regex) supaya paragraf/baris baru tetap masuk akal
    //    buat di-feed ke TTS nanti -- bukan cuma satu blok teks nyambung.
    const chapters = [];
    for (let i = 0; i < epub.flow.length; i++) {
      const item = epub.flow[i];

      const html = await new Promise((resolve, reject) => {
        epub.getChapter(item.id, (err, text) => {
          if (err) reject(err);
          else resolve(text);
        });
      });

      const plainText = convert(html || '', {
        wordwrap: false,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'a', options: { ignoreHref: true } },
        ],
      }).trim();

      // Lewati bab yang hasilnya kosong (biasanya halaman sampul/copyright
      // yang isinya cuma gambar tanpa teks).
      if (!plainText) continue;

      const chapterTitle = item.title || `Chapter ${chapters.length + 1}`;
      const truncatedText = plainText.substring(0, MAX_CHAPTER_TEXT_LENGTH);

      const chapterDoc = await databases.createDocument(
        process.env.APPWRITE_DATABASE_ID,
        'document_chapters',
        ID.unique(),
        {
          book_id: bookDoc.$id,
          chapter_index: chapters.length,
          title: String(chapterTitle).substring(0, 255),
          text_content: truncatedText,
        }
      );

      chapters.push({
        id: chapterDoc.$id,
        index: chapterDoc.chapter_index,
        title: chapterDoc.title,
        charCount: plainText.length,
      });
    }

    log(`Parsed ${chapters.length} chapters successfully.`);

    return res.json({
      success: true,
      bookId: bookDoc.$id,
      title: bookTitle,
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
