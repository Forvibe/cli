# @forvibe/cli - NPM Deployment Rehberi

Bu doküman, `@forvibe/cli` paketinin npmjs.com üzerinde yayınlanması için gereken tüm adımları detaylı şekilde açıklar.

---

## Genel Bakış

Paket yayınlandığında kullanıcılar şu şekilde çalıştırabilecek:

```bash
# Direkt çalıştırma (kurulum gerektirmez)
npx @forvibe/cli

# veya global kurulum
npm install -g @forvibe/cli
forvibe analyze
```

---

## Ön Gereksinimler

- **Node.js**: >= 18
- **npm**: >= 9 (Node.js ile birlikte gelir)
- **npmjs.com hesabı**: https://www.npmjs.com/signup

---

## Adım 1: npm Hesabı Oluşturma ve Giriş

### 1.1 — Hesap Oluşturma

https://www.npmjs.com/signup adresinden bir hesap oluştur. E-posta doğrulamasını tamamla.

### 1.2 — Terminal'den Giriş Yapma

```bash
npm login
```

Bu komut seni tarayıcıya yönlendirecek. Giriş yaptıktan sonra terminal'de doğrulama tamamlanır.

### 1.3 — Giriş Doğrulama

```bash
npm whoami
# Çıktı: kullanıcı_adın
```

---

## Adım 2: npm Organization (Scope) Oluşturma

Paket adı `@forvibe/cli` olduğu için bir **npm organization** gereklidir.

### 2.1 — Organization Oluşturma

1. https://www.npmjs.com/org/create adresine git
2. Organization adı olarak `forvibe` gir
3. **Free** (ücretsiz) planı seç — public paketler için yeterli
4. "Create" butonuna tıkla

### 2.2 — Organization Doğrulama

```bash
npm org ls forvibe
```

> **Not:** Organization adı ile paket scope'u eşleşmelidir. Paket adı `@forvibe/cli` olduğu için organization adı `forvibe` olmalıdır.

---

## Adım 3: Projeyi Yayına Hazırlama

### 3.1 — Build Testi

```bash
npm run build
```

Bu komut `tsup` ile TypeScript'i derler ve `dist/` klasörüne çıktı üretir. Şunları doğrula:

- `dist/index.js` dosyası oluştu mu?
- Dosyanın ilk satırı `#!/usr/bin/env node` mı? (shebang line — CLI olarak çalışması için gerekli)

### 3.2 — Lokal Test

Build sonrası CLI'ı lokalde test et:

```bash
# Direkt çalıştır
node dist/index.js --help

# veya npm link ile global olarak test et
npm link
forvibe --help
forvibe analyze --dir /path/to/test-project

# Test bittikten sonra link'i kaldır
npm unlink -g @forvibe/cli
```

### 3.3 — Dry Run ile Yayın Simülasyonu

Gerçekten yayınlamadan önce ne gönderileceğini kontrol et:

```bash
npm run release:dry
```

veya sadece hangi dosyaların dahil edileceğini görmek için:

```bash
npm pack --dry-run
```

Çıktıda şunların **OLMADIĞINDAN** emin ol:
- `.env` (API key'ler!)
- `src/` (kaynak kod — sadece derlenmiş `dist/` gitmeli)
- `node_modules/`
- `tsconfig.json`

Çıktıda şunların **OLDUĞUNDAN** emin ol:
- `dist/index.js`
- `dist/index.d.ts`
- `package.json`

---

## Adım 4: İlk Yayın (First Publish)

### 4.1 — Versiyon Kontrolü

`package.json` içindeki versiyon numarasını kontrol et:

```json
{
  "version": "0.1.0"
}
```

İlk yayın için `0.1.0` uygundur.

### 4.2 — Yayınlama

```bash
npm run release
```

Bu komut şunları sırasıyla yapar:
1. `npm run build` — Projeyi derler
2. `npm publish --access public` — npm registry'e yayınlar

`--access public` flag'i **zorunludur** çünkü scoped paketler (`@forvibe/cli`) varsayılan olarak private'tır. Public yapmak için bu flag gerekir.

### 4.3 — Yayın Doğrulama

```bash
# npm üzerinde paketi kontrol et
npm view @forvibe/cli

# npx ile test et (farklı bir dizinde)
npx @forvibe/cli --help
```

https://www.npmjs.com/package/@forvibe/cli adresinden de kontrol edebilirsin.

---

## Adım 5: Versiyon Güncelleme ve Yeni Yayınlar

Her yeni yayın için versiyon numarası artırılmalıdır.

### 5.1 — Semantic Versioning (SemVer)

```
MAJOR.MINOR.PATCH
  │      │     └── Bug fix, küçük değişiklikler (0.1.0 → 0.1.1)
  │      └──────── Yeni özellik, geriye uyumlu (0.1.0 → 0.2.0)
  └─────────────── Breaking change, geriye uyumsuz (0.x.x → 1.0.0)
```

### 5.2 — Versiyon Artırma

```bash
# Patch: 0.1.0 → 0.1.1 (bug fix)
npm version patch

# Minor: 0.1.0 → 0.2.0 (yeni özellik)
npm version minor

# Major: 0.1.0 → 1.0.0 (breaking change)
npm version major
```

Bu komutlar otomatik olarak:
- `package.json` içindeki `version` alanını günceller
- Eğer git repo'sundaysan bir commit ve tag oluşturur

### 5.3 — Güncellemeyi Yayınlama

```bash
npm run release
```

> **Önemli:** `src/index.ts` içindeki `.version("0.1.0")` satırını da güncellemeyi unutma! Veya daha iyisi, `package.json`'dan dinamik okumayı düşünebilirsin.

---

## Adım 6: CI/CD ile Otomatik Yayın (Opsiyonel)

GitHub Actions ile otomatik yayın kurulumu:

### 6.1 — npm Token Oluşturma

1. https://www.npmjs.com → Avatar → "Access Tokens" → "Generate New Token"
2. **Granular Access Token** seç
3. Token adı: `github-actions-publish`
4. Expiration: İhtiyaca göre (örn. 1 yıl)
5. Packages and scopes: `Read and write`
6. Select packages: `@forvibe/cli`
7. "Generate Token" → Token'ı kopyala

### 6.2 — GitHub'a Token Ekleme

1. GitHub repo → Settings → Secrets and variables → Actions
2. "New repository secret" tıkla
3. Name: `NPM_TOKEN`
4. Value: Kopyaladığın token

### 6.3 — GitHub Actions Workflow

`.github/workflows/publish.yml` dosyası oluştur:

```yaml
name: Publish to npm

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org

      - run: npm ci

      - run: npm run build

      - run: npm run typecheck

      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 6.4 — Otomatik Yayın Akışı

1. Kodu geliştir ve commit'le
2. GitHub'da yeni bir Release oluştur (tag ile: `v0.2.0`)
3. GitHub Actions otomatik olarak npm'e yayınlar

---

## Güvenlik Kontrol Listesi

- [ ] `.env` dosyası `.gitignore` ve `.npmignore` içinde
- [ ] `npm pack --dry-run` çıktısında hassas dosya yok
- [ ] `package.json` → `files` alanı sadece `["dist"]` içeriyor
- [ ] API key'ler hiçbir zaman kaynak koda gömülmüyor
- [ ] npm 2FA (iki faktörlü doğrulama) aktif — https://www.npmjs.com → Security

---

## Sorun Giderme

### "402 Payment Required" hatası
Scoped paketler varsayılan olarak private'tır. `--access public` flag'ini kullandığından emin ol:
```bash
npm publish --access public
```

### "403 Forbidden" hatası
- npm'e giriş yaptığını doğrula: `npm whoami`
- Organization'a üye olduğunu doğrula: `npm org ls forvibe`
- Token izinlerini kontrol et

### "E409 Conflict" hatası
Aynı versiyon zaten yayınlanmış. Versiyon numarasını artır:
```bash
npm version patch
```

### npx çalıştırdığında "command not found"
`package.json` → `bin` alanını kontrol et:
```json
{
  "bin": {
    "forvibe": "./dist/index.js"
  }
}
```
Ayrıca `dist/index.js` dosyasının ilk satırının shebang olduğunu doğrula:
```
#!/usr/bin/env node
```

### "ERR! 404 Not Found - PUT" hatası
Organization oluşturulmamış olabilir. Adım 2'yi kontrol et.

---

## Hızlı Referans Komutları

| Komut | Açıklama |
|-------|----------|
| `npm login` | npm'e giriş yap |
| `npm whoami` | Giriş yapılan hesabı göster |
| `npm run build` | Projeyi derle |
| `npm run release:dry` | Yayın simülasyonu (göndermez) |
| `npm run release` | Build + Publish |
| `npm version patch` | Versiyon artır (patch) |
| `npm pack --dry-run` | Dahil edilecek dosyaları listele |
| `npm view @forvibe/cli` | Yayınlanan paketi görüntüle |
| `npm deprecate @forvibe/cli@"<0.1.0" "mesaj"` | Eski versiyonları deprecated yap |
| `npm unpublish @forvibe/cli@0.1.0` | Versiyonu kaldır (72 saat içinde) |

---

## Dosya Yapısı (Yayınlanan Paket)

npm'e yayınlandığında paketin içeriği şu şekilde olacak:

```
@forvibe/cli/
├── dist/
│   ├── index.js          # CLI entry point (shebang ile)
│   ├── index.d.ts        # TypeScript type declarations
│   └── ...               # Diğer derlenmiş dosyalar
├── package.json
└── (LICENSE, README.md varsa dahil edilir)
```
