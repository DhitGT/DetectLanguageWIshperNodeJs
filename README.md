# COMPAC Audio Language Detector — Node.js

Service mandiri **Node.js 22.9+**, Fastify, Transformers.js, dan ONNX Runtime CPU. Whisper multilingual membaca token bahasa setelah start-of-transcript dengan **satu langkah decoder**, tanpa menghasilkan transkripsi. Silero VAD menyaring bagian tanpa ucapan. FFmpeg mendekode audio menjadi mono 16 kHz. Tidak membutuhkan Python, API OpenAI, ataupun GPU.

## How to install — instalasi lokal

### Prasyarat

- Node.js **22.9 atau lebih baru** beserta npm.
- Internet untuk instalasi dependensi dan unduhan model pertama.
- Folder proyek ini sudah tersedia di komputer.

Tidak perlu memasang FFmpeg terpisah jika binary `ffmpeg-static` berhasil diunduh saat instalasi.

### Windows (PowerShell)

```powershell
cd C:\CODE\Compac\DetectLanguageWishper
npm.cmd ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Isi API_KEY di .env dengan secret hasil perintah di atas.
notepad .env
npm.cmd start
```

Jika `.env` sudah ada, edit file tersebut tanpa menimpanya dengan `.env.example`.

### Linux (Bash)

Jalankan dari folder proyek:

```bash
npm ci
cp .env.example .env
openssl rand -hex 32
# Isi API_KEY di .env dengan secret hasil perintah di atas.
nano .env
chmod 600 .env
npm start
```

### Periksa aplikasi lokal

Tunggu log server mulai menerima koneksi, lalu buka terminal kedua:

```bash
curl --fail http://127.0.0.1:8000/readyz
```

Pada PowerShell gunakan `curl.exe`. Untuk menghentikan aplikasi lokal, tekan `Ctrl+C` pada terminal yang menjalankan `npm start`.

Startup pertama mengunduh model ONNX Whisper `base` dan Silero VAD ke folder `models`; butuh internet. Model dimuat sekali di worker thread dan digunakan kembali. Server menerima request setelah model siap. Jangan menggunakan model `.en`, karena hanya mendukung bahasa Inggris. Bila mengubah model, pastikan format ONNX cocok dengan Transformers.js dan metadata `lang_to_id` tersedia.

`ffmpeg-static` menyediakan binary Windows/Linux. Bila install script diblokir kebijakan npm Anda, izinkan install script paket tepercaya yang tercantum saat instalasi, atau set `FFMPEG_PATH` ke FFmpeg sistem. Dependensi ONNX Runtime juga memiliki native binary. Dockerfile menggunakan runtime CPU dan menonaktifkan unduhan CUDA.

## How to deploy — server Linux dengan Docker

### 1. Siapkan server

- Server **Linux x86_64**, misalnya Ubuntu/Debian, dengan akses SSH.
- Docker Engine dan Docker Compose v2 sudah terpasang dan dapat dijalankan oleh pengguna deploy.
- Internet untuk mengunduh image, dependensi, dan model pertama.
- Untuk akses publik: domain/subdomain, Nginx di host, dan sertifikat HTTPS.

Periksa Docker di server:

```bash
docker --version
docker compose version
```

Compose saat ini memberi batas **4 CPU dan RAM 2 GB** untuk detector. Sediakan sumber daya tambahan untuk OS, Docker, dan layanan lain. Nilai ini adalah konfigurasi awal, **bukan benchmark kapasitas**; sesuaikan `cpus`, `mem_limit`, dan `CPU_THREADS` setelah pengujian di server tujuan.

### 2. Upload proyek ke server

Dari PowerShell di komputer lokal, buat arsip sumber aplikasi:

```powershell
cd C:\CODE\Compac\DetectLanguageWishper
tar -czf detector-deploy.tar.gz Dockerfile compose.yaml package.json package-lock.json .env.example src deploy
scp detector-deploy.tar.gz USER@IP_SERVER:~/
```

Ganti `USER` dan `IP_SERVER` dengan akun SSH dan alamat server. Arsip ini tidak menyertakan `.env`, `node_modules`, atau model lokal. Dependensi Linux dibangun di dalam image Docker dan model diunduh di server.

Masuk ke server, lalu ekstrak:

```bash
ssh USER@IP_SERVER
mkdir -p ~/language-detector
tar -xzf ~/detector-deploy.tar.gz -C ~/language-detector
cd ~/language-detector
```

Seluruh perintah deploy berikut dijalankan di folder `~/language-detector` pada server.

### 3. Buat konfigurasi server

```bash
cp .env.example .env
openssl rand -hex 32
# Isi API_KEY di .env dengan hasil di atas.
nano .env
chmod 600 .env
```

`API_KEY` wajib berupa secret acak minimal 32 karakter; nilai contoh `CHANGE_ME...` akan ditolak. Simpan secret ini untuk konfigurasi backend COMPAC.

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `API_KEY` | Harus diisi | Secret untuk header Authorization. |
| `WHISPER_MODEL` | `onnx-community/whisper-base` | Model multilingual. |
| `CPU_THREADS` | `4` | Thread inference; sesuaikan CPU server. |
| `MAX_UPLOAD_MB` | `8` | Batas ukuran berkas audio dalam MiB. |
| `MAX_AUDIO_SECONDS` | `30` | Batas durasi audio; maksimal 30 detik. |
| `MIN_SPEECH_SECONDS` | `0.6` | Minimal ucapan yang lolos VAD. |
| `MIN_CONFIDENCE` | `0.7` | Ambang hasil `detected`. |
| `MAX_IN_FLIGHT` | `2` | Maksimal request aktif. |
| `CORS_ORIGINS` | Kosong | Default untuk komunikasi server-to-server. |

Compose menimpa `HOST`, `PORT`, dan `MODEL_CACHE` menjadi `0.0.0.0`, `8000`, dan `/models` khusus di container. Biarkan `FFMPEG_PATH` kosong agar menggunakan binary bawaan. Jika mengubah batas upload, sesuaikan juga `client_max_body_size` pada kedua lapisan Nginx, dengan ruang untuk overhead multipart.

### 4. Build dan jalankan

```bash
docker compose up -d --build
docker compose logs -f detector
```

Tunggu unduhan dan pemuatan model selesai. Gateway baru dijalankan setelah detector sehat. Tekan `Ctrl+C` untuk keluar dari log; container tetap berjalan.

```bash
docker compose ps
curl --fail http://127.0.0.1:8088/readyz
```

Gateway terikat ke **127.0.0.1:8088** pada host. Port detector `8000` hanya tersedia di jaringan Compose. Jika backend COMPAC berada di host yang sama, backend dapat menggunakan `http://127.0.0.1:8088`.

Volume `models` menyimpan model antarrestart. Container detector berjalan sebagai non-root dengan filesystem utama read-only.

### 5. Pasang domain dan HTTPS

Alur akses publik:

```text
Backend COMPAC -> HTTPS Nginx host :443 -> gateway localhost:8088 -> detector :8000
```

Contoh berikut untuk Ubuntu/Debian dengan Nginx host. Ganti **semua** kemunculan `language.example.com` dengan domain Anda. Arahkan DNS domain ke server terlebih dahulu, termasuk record IPv6 jika digunakan. Izinkan port 80/443 pada firewall server dan penyedia cloud; pertahankan akses SSH. Port 8088 dan 8000 tidak perlu dibuka.

Jika Nginx dan sertifikat domain sudah tersedia, langsung gunakan [template Nginx publik](deploy/public-nginx.conf.example) dengan domain dan path sertifikat yang sesuai, lalu validasi dan reload.

Untuk server yang belum memiliki sertifikat, instal Nginx dan Certbot:

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot
sudo mkdir -p /var/www/letsencrypt
sudo nano /etc/nginx/sites-available/language-detector
```

Isi konfigurasi HTTP sementara berikut agar Certbot dapat memvalidasi domain:

```nginx
server {
    listen 80;
    server_name language.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 404;
    }
}
```

Aktifkan konfigurasi, lalu terbitkan sertifikat:

```bash
sudo ln -s /etc/nginx/sites-available/language-detector /etc/nginx/sites-enabled/language-detector
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt -d language.example.com
```

Jalankan `ln -s` hanya saat symlink belum ada. Setelah sertifikat berhasil diterbitkan, ganti konfigurasi sementara dengan template proyek:

```bash
sudo cp deploy/public-nginx.conf.example /etc/nginx/sites-available/language-detector
sudo nano /etc/nginx/sites-available/language-detector
```

Ganti domain dan kedua path sertifikat. Agar pembaruan sertifikat webroot tetap berjalan, ubah blok `server` port 80 pada template menjadi:

```nginx
server {
    listen 80;
    server_name language.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

Pertahankan blok HTTPS port 443 dari template. Selanjutnya:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://language.example.com/readyz
sudo certbot renew --dry-run
```

Pastikan penjadwalan pembaruan Certbot aktif pada server. Tambahkan deploy hook agar Nginx memuat sertifikat baru setelah renewal berhasil:

```bash
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nnginx -t && systemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh > /dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

### 6. Uji deteksi audio

Sediakan `sample.wav` berisi sekitar 3–10 detik ucapan pada server, lalu jalankan di Bash:

```bash
read -rsp 'API key: ' LANGUAGE_API_KEY
echo
curl --fail-with-body https://language.example.com/v1/detect-language \
  -H "Authorization: Bearer $LANGUAGE_API_KEY" \
  -F 'file=@sample.wav'
unset LANGUAGE_API_KEY
```

Untuk pengujian sebelum HTTPS tersedia, ganti URL dengan `http://127.0.0.1:8088/v1/detect-language`. Respons berhasil berisi `status`, `language`, `suggested_locale`, dan `confidence`. Audio dengan confidence rendah dapat menghasilkan `status: "uncertain"`.

### 7. Operasional dan pembaruan

```bash
# Status dan log
docker compose ps
docker compose logs --tail=100 detector gateway

# Terapkan perubahan kode setelah upload dan ekstrak arsip baru
docker compose up -d --build

# Terapkan perubahan .env atau compose.yaml
docker compose up -d

# Restart proses tanpa mengubah konfigurasi
docker compose restart

# Hentikan dan hapus container; volume model tetap tersimpan
docker compose down
```

Saat memperbarui dari arsip, ulangi langkah upload dan ekstraksi di folder yang sama. Pertahankan `.env` server; jangan ulangi `cp .env.example .env`. Perubahan konfigurasi Nginx host memerlukan `sudo nginx -t` dan reload terpisah.

Jangan gunakan `docker compose down -v` kecuali memang ingin menghapus volume model. `docker compose restart` tidak menerapkan perubahan environment; gunakan `docker compose up -d`.

### Troubleshooting

| Gejala | Pemeriksaan / tindakan |
| --- | --- |
| Detector gagal start karena API key | Isi `API_KEY` minimal 32 karakter dan jangan gunakan nilai `CHANGE_ME`; jalankan `docker compose up -d`. |
| Startup lama atau gateway belum berjalan | Periksa `docker compose logs --tail=100 detector`; unduhan model pertama memerlukan internet dan waktu. |
| Detector `unhealthy` atau keluar dengan kode 137 | Periksa log, `docker stats --no-stream`, dan status OOM; sesuaikan batas RAM jika proses kehabisan memori. |
| HTTPS menghasilkan 502 | Periksa `curl http://127.0.0.1:8088/readyz`, status container, dan upstream Nginx. |
| HTTP 401 | Cocokkan Bearer token dengan `API_KEY` di `.env` server. |
| HTTP 413 | Periksa ukuran file, `MAX_UPLOAD_MB`, dan batas body pada kedua lapisan Nginx. |
| HTTP 429 | Kurangi request paralel dan beri jeda sebelum mencoba ulang. |
| Sertifikat gagal diterbitkan / diperbarui | Periksa DNS, akses port 80, dan location `/.well-known/acme-challenge/` pada Nginx host. |


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
