# COMPAC Audio Language Detector — Node.js

Service mandiri **Node.js 22.9+**, Fastify, Transformers.js, dan ONNX Runtime CPU. Whisper multilingual membaca token bahasa setelah start-of-transcript dengan **satu langkah decoder**, tanpa menghasilkan transkripsi. Silero VAD menyaring bagian tanpa ucapan. FFmpeg mendekode audio menjadi mono 16 kHz. Tidak membutuhkan Python, API OpenAI, ataupun GPU.

## Jalankan lokal

```powershell
cd C:\CODE\Compac\DetectLanguageWishper
npm.cmd ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Isi API_KEY di .env dengan secret hasil perintah di atas.
npm.cmd start
```

Pada Linux gunakan `npm`, bukan `npm.cmd`. Startup pertama mengunduh model ONNX Whisper `base` dan Silero VAD ke folder `models`; butuh internet. Model dimuat sekali di worker thread dan digunakan kembali. Server menerima request setelah model siap. Jangan menggunakan model `.en`, karena hanya mendukung bahasa Inggris. Bila mengubah model, pastikan format ONNX cocok dengan Transformers.js dan metadata `lang_to_id` tersedia.

`ffmpeg-static` menyediakan binary Windows/Linux. Bila install script diblokir kebijakan npm Anda, izinkan install script paket tepercaya yang tercantum saat instalasi, atau set `FFMPEG_PATH` ke FFmpeg sistem. Dependensi ONNX Runtime juga memiliki native binary. Dockerfile menggunakan runtime CPU dan menonaktifkan unduhan CUDA.

## Deployment server publik

Server Linux x86_64 dengan Docker Engine dan Compose v2:

```sh
cp .env.example .env
openssl rand -hex 32
# Isi API_KEY di .env dengan hasil di atas.
docker compose up -d --build
docker compose logs -f detector
curl http://127.0.0.1:8088/readyz
```

Gateway terikat ke **127.0.0.1:8088**. Untuk akses publik, arahkan DNS subdomain ke server dan pasang HTTPS pada reverse proxy host menggunakan [contoh Nginx](deploy/public-nginx.conf.example). Ganti domain/path sertifikat, validasi `nginx -t`, lalu reload Nginx sesuai pengelolaan server Anda. Sertifikat dan DNS tidak diterbitkan otomatis. Buka port 443; port model 8000 tidak dipublikasikan.

Volume `models` menyimpan model antarrestart. Container berjalan sebagai non-root dengan filesystem utama read-only. Default alokasi 4 CPU dan RAM 2 GB adalah batas konfigurasi awal, **bukan benchmark kapasitas**. Sesuaikan berdasarkan pengujian di server; model `base` dan runtime ONNX memerlukan RAM di luar ukuran file bobot.

Inference di worker diserialkan; maksimal dua request aktif termasuk upload/decode/inference. Request tambahan ditolak 429. Gateway membatasi 2 request/detik dengan burst 10 per IP yang terlihat gateway; di belakang reverse proxy host ini menjadi batas gabungan klien. Tambahkan rate limit per pengguna/IP di proxy terluar sesuai kebutuhan. Jangan menjalankan banyak proses Node tanpa memperhitungkan duplikasi model/RAM.

## API

`POST /v1/detect-language`, header `Authorization: Bearer <API_KEY>`, body multipart dengan satu berkas bernama **file**.

```sh
curl --fail-with-body https://language.example.com/v1/detect-language \
  -H "Authorization: Bearer $LANGUAGE_API_KEY" \
  -F 'file=@sample.webm'
```

Pada PowerShell gunakan `curl.exe`. Format umum: WAV, FLAC, MP3, WebM/Opus, OGG, M4A, bergantung decoder FFmpeg. Setiap upload harus berkas mandiri yang dapat didekode; chunk lanjutan MediaRecorder tanpa header container tidak valid. Tidak menerima URL audio.

Contoh respons (angka hanya ilustrasi):

```json
{
  "status": "detected",
  "language": "en",
  "suggested_locale": "en-US",
  "confidence": 0.95,
  "alternatives": [{"language": "en", "confidence": 0.95}],
  "audio_seconds": 5,
  "speech_seconds": 4.2,
  "processing_ms": 180
}
```

`language` berasal dari audio. `suggested_locale` merupakan pemetaan default pilihan COMPAC (`id-ID`, `en-US`, `ar-SA`, `zh-CN`, `ja-JP`, `ko-KR`), bukan deteksi aksen. Bahasa lain menghasilkan locale `null`. Confidence adalah skor model, bukan jaminan akurasi.

Jika confidence kurang dari `MIN_CONFIDENCE`, respons HTTP 200 berisi `status: "uncertain"`, `language: null`, dan `suggested_locale: null`. Klien bisa mempertahankan bahasa sebelumnya atau mengirim sampel baru; kandidat tetap tersedia di `alternatives`.

- **401**: API key hilang/salah; diperiksa sebelum parsing audio.
- **400/415/422**: multipart/audio tidak valid, kosong, kurang dari 1 detik, terlalu panjang, atau ucapan terlalu sedikit.
- **413**: upload melebihi batas. Default berkas 8 MiB (termasuk request chunked). Header Content-Length juga diperiksa terhadap batas berkas + 64 KiB overhead; gateway membatasi keseluruhan body 9 MiB, termasuk chunked. Pertahankan gateway sebagai jalur akses publik.
- **408**: decoding terlalu lama; timeout decoder 15 detik, upload dibatasi server 30 detik.
- **429**: kapasitas/rate limit terlampaui. Batas request aktif memberikan `Retry-After: 2`.
- **503**: worker model/decoder belum siap.

Error aplikasi berbentuk `{"error":{"code":"no_speech","message":"..."}}`; respons penolakan Nginx dapat berbeda. `GET /healthz` dan `GET /readyz` tidak memerlukan key. Tidak tersedia endpoint transkripsi/terjemahan atau penyimpanan rekaman.

## Hubungkan ke COMPAC

Browser mengirim sampel sekitar 3–10 detik ucapan lewat backend COMPAC yang memeriksa sesi pengguna. Backend meneruskannya ke service ini dengan API key. **Secret disimpan di backend**, bukan `runtimeConfig.public` atau bundle frontend. CORS default kosong untuk komunikasi server-to-server.

Gunakan `suggested_locale` untuk mengatur bahasa Web Speech; hasil deteksi dapat dipakai selama sesi dan diperiksa ulang bila bahasa berganti. Potongan pendek, musik, kebisingan, atau campuran bahasa bisa keliru. Service memberi satu bahasa dominan per sampel, bukan label bahasa tiap kata. VAD mengurangi suara non-ucapan tetapi tidak menjamin semuanya tersaring.

Audio upload ditampung terbatas di RAM, diteruskan melalui stdin FFmpeg, kemudian dibuang setelah request. Tidak ada berkas rekaman permanen. Runtime inference berada di worker; output diagnostic tensor dari library tidak diteruskan ke log. Jangan mengaktifkan pencatatan body/header Authorization pada proxy. Service ini belum terhubung ke frontend COMPAC.

## Tes

```sh
npm test
```

Tes HTTP menggunakan detector stub; decoder FFmpeg berjalan nyata. Tes tambahan dengan model/audio asli:

```powershell
$env:SMOKE_AUDIO_FILE = 'C:\path\sample-english.flac'
$env:SMOKE_EXPECTED_LANGUAGE = 'en'
npm.cmd run test:model
```

Tes model mengunduh model jika belum ada. Pengujian akurasi rekaman Indonesia/Inggris, pergantian bahasa, dan kapasitas concurrent tetap perlu dilakukan dengan audio serta server tujuan.

## Model dan lisensi

- [Transformers.js](https://github.com/huggingface/transformers.js) dan [ONNX Whisper base](https://huggingface.co/onnx-community/whisper-base).
- [Silero VAD v5.1.2](https://github.com/snakers4/silero-vad/tree/v5.1.2), MIT. Unduhan model dipin ke versi dan diverifikasi SHA-256.
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) menyediakan binary FFmpeg; perhatikan lisensi binary bila mendistribusikan image.
# DetectLanguageWIshperNodeJs
