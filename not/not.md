What's NOT included (can be done later)
FAQ section (not legally required, nice-to-have)
Analytics setup (depends on hosting choice)
Favicon PNG fallback (minor)

## BEFORE LAUNCH - Replace placeholders
- Replace YOUR_DOMAIN in index.html og:image, og:url, twitter:image, and canonical meta tags with the real production URL
- Replace placeholder domain (https://example.com) in robots.txt and sitemap.xml with the real production URL
- Replace GA4 placeholder Measurement ID (G-XXXXXXXXXX) in index.html with the real GA4 ID
- Replace YOUR_RECAPTCHA_SITE_KEY in index.html (2 occurrences: script tag + grecaptcha.execute call) with real reCAPTCHA v3 site key from https://www.google.com/recaptcha/admin
- Replace YOUR_RECAPTCHA_SECRET_KEY in the Google Apps Script with the real reCAPTCHA v3 secret key
- Update Google Apps Script backend with the new doPost function (see apps-script.js in repo)