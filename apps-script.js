/**
 * Google Apps Script - Triad Waitlist Backend
 *
 * Copy this entire file into your Google Apps Script editor
 * (script.google.com) and deploy as a web app.
 *
 * SETUP:
 * 1. Replace YOUR_RECAPTCHA_SECRET_KEY with your reCAPTCHA v3 secret key
 * 2. Make sure your Google Sheet has headers in row 1: Email, Timestamp, IP
 * 3. Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone
 */

var RECAPTCHA_SECRET = 'YOUR_RECAPTCHA_SECRET_KEY';
var EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function doPost(e) {
  try {
    var params = e.parameter;

    // 1. Honeypot check - bots fill this hidden field
    if (params.website && params.website.length > 0) {
      return ContentService.createTextOutput(JSON.stringify({ result: 'success' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Email validation
    var email = (params.email || '').trim().toLowerCase();
    if (!email || !EMAIL_REGEX.test(email)) {
      return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: 'Invalid email' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. reCAPTCHA verification (if token provided)
    if (params.captcha_token) {
      var captchaResponse = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'post',
        payload: {
          secret: RECAPTCHA_SECRET,
          response: params.captcha_token
        }
      });
      var captchaResult = JSON.parse(captchaResponse.getContentText());
      if (!captchaResult.success || captchaResult.score < 0.5) {
        return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: 'Verification failed' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // 4. Duplicate detection - check if email already exists
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().toLowerCase() === email) {
        return ContentService.createTextOutput(JSON.stringify({ result: 'duplicate', message: 'Already registered' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // 5. Rate limiting by email pattern (prevent rapid signups)
    var now = new Date();
    var recentCount = 0;
    var tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    for (var j = data.length - 1; j >= 1; j--) {
      var rowTime = new Date(data[j][1]);
      if (rowTime < tenMinutesAgo) break;
      recentCount++;
    }
    if (recentCount > 20) {
      return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: 'Too many signups' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 6. All checks passed - save to spreadsheet
    sheet.appendRow([email, now.toISOString()]);

    return ContentService.createTextOutput(JSON.stringify({ result: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: 'Server error' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}
