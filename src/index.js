const { Client, Databases, Storage, ID } = require('node-appwrite');
const { sendPushNotification } = require('./pushNotificationHelper');
// 🔧 FIX: `InputFile` TIDAK ADA di node-appwrite v13 (itu API dari versi
// SDK lain/beda) -- versi ini butuh objek `File` ASLI dari package
// `node-fetch-native-with-agent` (dependency internal node-appwrite
// sendiri), soalnya createFile() ngecek `instanceof` ke class File itu
// PERSIS, bukan cuma Buffer/objek generik.
const { File } = require('node-fetch-native-with-agent');
const mammoth = require('mammoth');
const { Document, Packer, Paragraph } = require('docx');
const PDFDocument = require('pdfkit');
const Epub = require('epub-gen');
const AdmZip = require('adm-zip');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 📄 Function konversi dokumen 2 arah: EPUB / DOCX / PDF / TXT -> salah
// satu dari format itu juga. Alurnya SELALU 2 tahap:
//   1. Ekstrak jadi TEKS POLOS dari format sumber (extractText)
//   2. Generate format tujuan DARI teks polos itu (generateFile)
// Ini artinya konversi PRESERVE ISI TEKS dengan baik, tapi TIDAK preserve
// formatting/gambar/layout kompleks dari dokumen asli -- hasil generate
// ke EPUB/DOCX/PDF itu selalu dokumen simpel (paragraf polos), bukan
// replika visual 1:1 dari sumbernya. Ini batasan yang disengaja (konversi
// programatik murni, tanpa AI, supaya cepat & murah).

// ============================================================
// EKSTRAK TEKS DARI FORMAT SUMBER
// ------------------------------------------------------------

// 🔧 FIX PENTING: sebelumnya pakai `pdf-parse`, TAPI terbukti gagal total
// ("bad XRef entry") buat PDF hasil generate `pdfkit` sendiri (dipakai di
// generatePdf() di bawah) -- ini genuine incompatibility versi pdf.js lama
// yang di-bundle `pdf-parse`, BUKAN soal PDF-nya rusak. `pdfjs-dist`
// (versi lebih baru, aktif di-maintain) terbukti bisa baca PDF yang sama
// tanpa masalah -- makanya dipakai di sini. `pdfjs-dist` itu ESM (.mjs),
// jadi WAJIB pakai dynamic import(), bukan require() biasa.
async function extractTextFromPdf(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = path.join(
    require.resolve('pdfjs-dist/package.json').replace('package.json', ''),
    'standard_fonts/'
  );

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl,
  }).promise;

  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item) => item.str).join(' ') + '\n\n';
  }
  return fullText.trim();
}

async function extractTextFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

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

// 🔧 FIX PENTING: sebelumnya cuma nyari SEMUA file .html/.xhtml di ZIP
// dan sortir alfabetis -- itu ikut ngambil halaman navigasi/Table of
// Contents yang jadinya "nyampur" di teks hasil ekstrak. Sekarang parsing
// EPUB dengan BENAR sesuai spesifikasinya:
//   1. Baca META-INF/container.xml -> nemuin lokasi file .opf
//   2. Baca file .opf -> ambil <manifest> (peta id -> file) dan <spine>
//      (URUTAN BACA resmi buku ini)
//   3. Ekstrak teks HANYA dari item di spine, urut sesuai spine, SKIP
//      item yang ditandai properties="nav" (halaman navigasi EPUB3)
async function extractTextFromEpub(buffer) {
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

  let fullText = '';
  for (const id of spineIds) {
    const item = manifest[id];
    if (!item || item.isNav) continue;
    const fullPath = opfDir + item.href;
    const contentEntry = zip.getEntry(fullPath);
    if (!contentEntry) continue;
    const html = contentEntry.getData().toString('utf-8');
    fullText += stripHtmlTags(html) + '\n\n';
  }

  return fullText.trim();
}

async function extractText(buffer, format) {
  switch (format) {
    case 'pdf':
      return extractTextFromPdf(buffer);
    case 'docx':
      return extractTextFromDocx(buffer);
    case 'epub':
      return extractTextFromEpub(buffer);
    case 'txt':
      return buffer.toString('utf-8');
    default:
      throw new Error(`Unsupported source format: ${format}`);
  }
}

// ============================================================
// GENERATE FORMAT TUJUAN DARI TEKS
// ------------------------------------------------------------

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function generateDocx(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((para) => new Paragraph({ text: para.trim() }));
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}

async function generatePdf(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(12).text(text, { align: 'left' });
    doc.end();
  });
}

// epub-gen nulis ke FILE (bukan langsung ke buffer) -- generate ke /tmp
// dulu, baru dibaca lagi jadi buffer, terus file sementaranya dihapus.
async function generateEpub(text, title) {
  const outputPath = path.join(os.tmpdir(), `converted-${Date.now()}.epub`);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const contentHtml = paragraphs.map((p) => `<p>${escapeHtml(p.trim())}</p>`).join('\n');

  const options = {
    title: title || 'Converted Document',
    author: 'NaratorAI',
    content: [{ title: title || 'Converted Document', data: contentHtml }],
  };

  await new Epub(options, outputPath).promise;
  const buffer = fs.readFileSync(outputPath);
  fs.unlinkSync(outputPath);
  return buffer;
}

async function generateFile(text, format, title) {
  switch (format) {
    case 'txt':
      return Buffer.from(text, 'utf-8');
    case 'docx':
      return generateDocx(text);
    case 'pdf':
      return generatePdf(text);
    case 'epub':
      return generateEpub(text, title);
    default:
      throw new Error(`Unsupported target format: ${format}`);
  }
}

function mimeTypeFor(format) {
  switch (format) {
    case 'txt':
      return 'text/plain';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pdf':
      return 'application/pdf';
    case 'epub':
      return 'application/epub+zip';
    default:
      return 'application/octet-stream';
  }
}

// ============================================================
// MAIN HANDLER
// ------------------------------------------------------------

module.exports = async ({ req, res, log, error }) => {
  const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
  const CONVERT_JOBS_COLLECTION_ID = 'convert_jobs';
  const OUTPUT_BUCKET_ID = process.env.APPWRITE_BUCKET_ID; // bucket yang sama dipakai fitur lain (audio/video)

  let requestId;
  let databases;

  try {
    const payload = JSON.parse(req.body || '{}');
    const { requestId: reqId, sourceUrl, sourceFormat, targetFormat, title } = payload;
    requestId = reqId;

    if (!requestId) return res.json({ success: false, error: 'requestId is required' }, 400);
    if (!sourceUrl) return res.json({ success: false, error: 'sourceUrl is required' }, 400);
    if (!sourceFormat) return res.json({ success: false, error: 'sourceFormat is required' }, 400);
    if (!targetFormat) return res.json({ success: false, error: 'targetFormat is required' }, 400);

    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);
    databases = new Databases(client);
    const storage = new Storage(client);

    log(`Converting job ${requestId}: ${sourceFormat} -> ${targetFormat}`);

    // 1. Download file sumber
    const fileResponse = await fetch(sourceUrl);
    if (!fileResponse.ok) throw new Error(`Failed to download source file: ${fileResponse.status}`);
    const arrayBuffer = await fileResponse.arrayBuffer();
    const sourceBuffer = Buffer.from(arrayBuffer);

    // 2. Ekstrak jadi teks polos
    log('Extracting text from source...');
    const extractedText = await extractText(sourceBuffer, sourceFormat);

    if (!extractedText || !extractedText.trim()) {
      throw new Error('No text could be extracted from the source document.');
    }

    // 3. Generate format tujuan dari teks itu
    log(`Generating ${targetFormat} output...`);
    const outputBuffer = await generateFile(extractedText, targetFormat, title);

    // 4. Upload hasil ke Storage
    const fileId = ID.unique();
    const fileName = `converted-${fileId}.${targetFormat}`;
    const uploadedFile = await storage.createFile(
      OUTPUT_BUCKET_ID,
      fileId,
      new File([outputBuffer], fileName, { type: mimeTypeFor(targetFormat) })
    );
    const outputUrl = `${process.env.APPWRITE_FUNCTION_API_ENDPOINT}/storage/buckets/${OUTPUT_BUCKET_ID}/files/${uploadedFile.$id}/view?project=${process.env.APPWRITE_FUNCTION_PROJECT_ID}`;

    // 5. Simpen hasil ke Database -- client polling dokumen ini
    const updatedJob = await databases.updateDocument(DATABASE_ID, CONVERT_JOBS_COLLECTION_ID, requestId, {
      status: 'completed',
      output_url: outputUrl,
      extracted_text_preview: extractedText.slice(0, 500), // buat preview singkat di UI
    });

    log(`Conversion job ${requestId} completed.`);

    // 🔔 Kirim push notification -- CATATAN: Document Converter saat ini
    // cuma ada di web, dan browser tidak bisa nerima Expo push
    // notification, jadi baris ini praktis TIDAK AKAN kelihatan efeknya
    // sampai (kalau) ada versi mobile Document Converter di masa depan.
    // Tetap disertakan sekarang biar konsisten & siap pakai begitu itu
    // ada -- aman, kalau tidak ketemu push token, cuma di-skip diam-diam
    // (lihat sendPushNotification()).
    if (updatedJob.user_id) {
      await sendPushNotification(
        databases,
        DATABASE_ID,
        updatedJob.user_id,
        'Document Ready! 📄',
        'Your converted document is ready to download.',
        { type: 'document_ready', requestId }
      );
    }

    return res.json({ success: true, outputUrl });
  } catch (err) {
    error(`Conversion failed: ${err.message}`);
    if (requestId && databases) {
      try {
        await databases.updateDocument(DATABASE_ID, CONVERT_JOBS_COLLECTION_ID, requestId, {
          status: 'failed',
          error_message: err.message,
        });
      } catch (updateErr) {
        error(`Failed to update job status: ${updateErr.message}`);
      }
    }
    return res.json({ success: false, error: err.message }, 500);
  }
};
