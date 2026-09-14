# تحويل من ZIP إلى APK — JABAR 2.0

هذا المشروع هو محرك بناء حقيقي وليس زرًا وهميًا. يستقبل ملفًا، مشروعًا أو رابطًا، يحاول اكتشاف نوع المصدر، ثم يختار مسار البناء المناسب.

## المصادر المدعومة

- Android Gradle: يبني `assembleDebug`.
- Flutter: `flutter pub get` ثم `flutter build apk --debug` عند توفر Flutter SDK.
- React Native: يثبت الحزم ثم يبني `android/gradlew assembleDebug`.
- Capacitor/Ionic: `npx cap sync android` ثم Gradle.
- Web / PWA / HTML / CSS / JS: يُغلف داخل WebView APK.
- PDF / صور / ملفات نصية وبيانات: ينشئ تطبيق عارض محلي ثم APK.
- رابط GitHub لمستودع: يُنزَّل كمصدر ZIP.
- رابط صفحة عادي: يُغلف كتطبيق WebView مباشر.

## تشغيل

```bash
npm install
npm start
```

ثم افتح:
`http://localhost:8080`

## Docker

```bash
docker compose up --build
```

## ملاحظة مهمة

لا توجد طريقة صادقة لتحويل "أي ملف مهما كان" إلى تطبيق Android كامل دون معرفة طبيعة المصدر وامتلاك محرك البناء المطلوب. هذا المشروع يوسّع التغطية إلى عدة أنواع شائعة ويعطي خطأ صريحًا للمشاريع غير المدعومة بدل صنع APK شكلي.

لمشاريع Android/Flutter/React Native الكبيرة، نجاح البناء يعتمد على توافق المشروع نفسه مع إصدارات JDK/SDK/Gradle والأدوات الموجودة على الخادم.
