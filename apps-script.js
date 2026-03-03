/**
 * Google Apps Script - Triad Waitlist Backend
 *
 * Copy this entire file into your Google Apps Script editor
 * (script.google.com) and deploy as a web app.
 *
 * SETUP:
 * 1. Go to Project Settings > Script Properties > Add: RECAPTCHA_SECRET = your_secret_key
 * 2. Make sure your Google Sheet has headers in row 1: Email, Timestamp
 * 3. Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone
 */

var EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function doPost(e) {
  try {
    var RECAPTCHA_SECRET = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
    var params = e.parameter;

    // 1. Honeypot check - bots fill this hidden field
    if (params.website && params.website.length > 0) {
      return ContentService.createTextOutput(JSON.stringify({ result: 'success' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Email validation
    var email = (params.email || '').trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) {
      return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: "That doesn't look like a valid email." }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. reCAPTCHA verification (mandatory)
    if (!params.captcha_token) {
      return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: 'Verification required. Please try again.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var captchaResponse = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'post',
      payload: {
        secret: RECAPTCHA_SECRET,
        response: params.captcha_token
      }
    });
    var captchaResult = JSON.parse(captchaResponse.getContentText());
    if (!captchaResult.success || captchaResult.score < 0.7 || captchaResult.action !== 'submit') {
      return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: "We couldn't verify your submission. Please try again." }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 4-6. Acquire lock to prevent TOCTOU race on duplicate check and write
    var lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
      var data = sheet.getDataRange().getValues();

      // 4. Duplicate detection - check if email already exists
      for (var i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString().toLowerCase() === email) {
          return ContentService.createTextOutput(JSON.stringify({ result: 'duplicate', message: "You're already on the list. See you at launch." }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }

      // 5. Rate limiting (scan all rows, no break, handles unsorted data)
      var now = new Date();
      var recentCount = 0;
      var tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
      for (var j = 1; j < data.length; j++) {
        var rowTime = new Date(data[j][1]);
        if (!isNaN(rowTime) && rowTime >= tenMinutesAgo) recentCount++;
      }
      if (recentCount > 20) {
        return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: "We're seeing a lot of signups right now. Try again in a few minutes." }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      // 6. All checks passed - save to spreadsheet
      sheet.appendRow([email, now.toISOString()]);
      var totalSignups = sheet.getLastRow() - 1;
      MailApp.sendEmail('REDACTED', 'New Triad Signup #' + totalSignups, 'New signup: ' + email + '\n\nTotal signups: ' + totalSignups);
    } finally {
      lock.releaseLock();
    }

    return ContentService.createTextOutput(JSON.stringify({ result: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: 'Something went wrong. Please try again shortly.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}
