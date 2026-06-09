# Diem danh hoi thao

Ung dung web de chieu QR diem danh, nhan form tu dien thoai va xuat Excel.

## Chay ung dung

```bash
npm start
```

Mo man hinh QR tren may chieu:

```text
http://localhost:3000
```

Khi vao trang, nhap ten cuoc hop va bam `Tao ma`. Ung dung se mo mot tab rieng chi de chieu QR, phia tren la ten cuoc hop va phia duoi QR la so giay con lai truoc khi doi ma.

Dien thoai tham gia can cung mang Wi-Fi/LAN voi may chay server. Server se in dia chi LAN dang dung, vi du:

```text
http://192.168.1.195:3000
```

Neu can chi dinh dia chi cong khai khac:

```bash
PUBLIC_URL=http://192.168.1.20:3000 npm start
```

## Cau hinh Supabase

1. Tao project tren Supabase.
2. Mo SQL Editor va chay noi dung file `supabase.sql`.
3. Tao file `.env` tu mau `.env.example`.
4. Dien gia tri:

```text
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_TABLE=attendance
```

`SUPABASE_SERVICE_ROLE_KEY` chi duoc dung tren server. Khong dua key nay vao file frontend hoac repo public.

## Deploy Netlify

Repo da co `netlify.toml`, trong do:

- `public` la thu muc publish.
- `netlify/functions` chay backend API.
- Cac route `/api/*`, `/checkin`, `/export.xlsx` duoc rewrite vao Netlify Function.

Tren Netlify, tao site tu GitHub repo va cau hinh:

```text
Build command: de trong
Publish directory: public
Functions directory: netlify/functions
```

Them Environment variables trong Netlify:

```text
SUPABASE_URL=https://xhqizslrurmxvoqgaglx.supabase.co
SUPABASE_ANON_KEY=key-cua-ban
SUPABASE_TABLE=attendance
QR_SECRET=mot-chuoi-bi-mat-bat-ky
```

Neu co `SUPABASE_SERVICE_ROLE_KEY`, nen dung key do thay cho anon key:

```text
SUPABASE_SERVICE_ROLE_KEY=service-role-key
```

Sau khi them bien moi truong, deploy lai site.

## Du lieu

- QR tu doi moi moi 20 giay.
- Link quet QR tao mot phien form ngan han trong 180 giay.
- Neu co `.env` Supabase, du lieu luu vao table `attendance`.
- Neu chua cau hinh Supabase, du lieu tam luu tai `data/attendance.json`.
- Nut `Xuat Excel` tai file `diem-danh-hoi-thao.xlsx`.
- Nut `Xoa du lieu` xoa toan bo danh sach diem danh hien tai.
