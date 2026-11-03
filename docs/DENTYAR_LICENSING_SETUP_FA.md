# راه‌اندازی API مجوز دنت‌یار (آزمایشی — هنوز فعال/منتشر نشود)

این API جدا از Worker همگام‌سازی فعلی است و نباید جایگزین آن شود. تا زمان تکمیل اتصال رابط برنامه و آزمایش قواعد Firebase، آن را Deploy نکنید.

## منابع موردنیاز
1. یک Worker جدید با نام `dentyar-licensing-api`؛ Worker فعلی `dentyar-sync-relay` را تغییر ندهید.
2. یک KV namespace تازه به نام `DENTYAR_LICENSES` و اتصال آن با binding برابر `LICENSES`.
3. متغیرهای Worker:
   - `OWNER_EMAIL`: ایمیل مالک Firebase که تأیید دومرحله‌ای/تأیید ایمیل آن فعال است.
   - `FIREBASE_PROJECT_ID`: `dentyar-458d9`
   - `FIREBASE_DATABASE_URL`: `https://dentyar-458d9-default-rtdb.firebaseio.com`
   - `RESEND_FROM`: فرستنده تأییدشده در Resend (اختیاری تا زمان فعال‌سازی ایمیل).
4. Secrets فقط در Cloudflare Worker:
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: محتوای JSON حساب سرویس Firebase Admin.
   - `RESEND_API_KEY`: کلید Resend؛ اختیاری تا زمان فعال‌سازی ایمیل.

## مسیرهای API
- `POST /v1/activation/request` — ثبت درخواست دستگاه.
- `POST /v1/activation/redeem` — مصرف کد و دریافت Firebase custom token.
- `POST /v1/owner/requests` — فهرست درخواست‌های در انتظار؛ نیازمند Firebase ID token مالک.
- `POST /v1/owner/approve` — تأیید درخواست و صدور کد یک‌بارمصرف.
- `POST /v1/owner/revoke` — لغو مجوز و ثبت وضعیت revoked در RTDB.
- `POST /v1/owner/licenses` — فهرست مجوزها.

## نکات امنیتی و وضعیت تکمیل
- کد فعال‌سازی یک‌بارمصرف، به شناسه دستگاه و کد مطب مقید و پس از مصرف حذف می‌شود.
- مالک با Firebase ID token و ایمیل تأییدشده احراز می‌شود.
- Worker با کلید Admin فقط در Secret Manager توکن می‌گیرد و رکورد مجوز را در RTDB می‌نویسد.
- فایل `firebase-database.rules.template.json` نمونه قواعدی است که باید پس از بررسی کامل مسیرهای موجود جایگزین/ادغام شود؛ آن را روی پایگاه اصلی اعمال نکنید.
- **این API به‌تنهایی هنوز نسخه نهایی قابل‌استفاده نیست.** اپ فعلی هنوز از Firebase email/password مشترک و دسترسی مستقیم RTDB استفاده می‌کند. لازم است در کلاینت، ورود custom-token، درخواست/مصرف کد، پنل مالک، جداسازی خواندن/نوشتن و تست‌های انتهابه‌انتها پیاده‌سازی شود. همچنین وضعیت revoked باید با قوانین RTDB در هر درخواست خواندن/نوشتن بررسی شود.
- قبل از انتشار، آزمون‌های pending/approved/rejected/expired/revoked، تلاش با دستگاه دیگر، مصرف دوباره کد، قطع اینترنت، حذف داده برنامه و تغییر شناسه دستگاه الزامی است.
- در این مرحله هیچ Secret، Firebase Rule یا Worker تولیدی تغییر نکرده است.
