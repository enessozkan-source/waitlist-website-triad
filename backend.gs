/**
 * Google Apps Script - Triad Waitlist Backend
 *
 * Copy this entire file into your Google Apps Script editor
 * (script.google.com) and deploy as a web app.
 *
 * SETUP:
 * 1. Go to Project Settings > Script Properties and add:
 *      RECAPTCHA_SECRET   = your_secret_key
 *      SPREADSHEET_ID     = your_spreadsheet_id  (the long ID from the Sheet URL)
 *      NOTIFICATION_EMAIL = the email address that receives signup alerts
 * 2. Make sure your Google Sheet has headers in row 1: Email, Timestamp
 * 3. Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const RECAPTCHA_SECRET = props.getProperty('RECAPTCHA_SECRET');
    const SPREADSHEET_ID = props.getProperty('SPREADSHEET_ID');
    const NOTIFICATION_EMAIL = props.getProperty('NOTIFICATION_EMAIL');
    const params = e.parameter;

    // 1. Honeypot check - bots fill this hidden field
    if (params.website && params.website.length > 0) {
      return jsonResponse({ result: 'success' });
    }

    // 2. Email validation
    const email = (params.email || '').trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) {
      return jsonResponse({ result: 'error', message: "That doesn't look like a valid email." });
    }

    // 3. reCAPTCHA verification (mandatory)
    if (!params.captcha_token) {
      return jsonResponse({ result: 'error', message: 'Verification required. Please try again.' });
    }
    const captchaResponse = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'post',
      payload: {
        secret: RECAPTCHA_SECRET,
        response: params.captcha_token
      }
    });
    const captchaResult = JSON.parse(captchaResponse.getContentText());
    if (!captchaResult.success || captchaResult.score < 0.5 || captchaResult.action !== 'submit') {
      return jsonResponse({ result: 'error', message: "We couldn't verify your submission. Please try again." });
    }

    // 4-6. Acquire lock to prevent TOCTOU race on duplicate check and write
    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getActiveSheet();
      const data = sheet.getDataRange().getValues();

      // 4. Duplicate detection
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString().toLowerCase() === email) {
          return jsonResponse({ result: 'duplicate', message: "You're already on the list. See you at launch." });
        }
      }

      // 5. Rate limiting - scan from bottom since rows are appended in order
      const now = new Date();
      const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
      let recentCount = 0;
      for (let j = data.length - 1; j >= 1; j--) {
        const rowTime = new Date(data[j][1]);
        if (isNaN(rowTime) || rowTime < tenMinutesAgo) break;
        recentCount++;
      }
      if (recentCount > 20) {
        return jsonResponse({ result: 'error', message: "We're seeing a lot of signups right now. Try again in a few minutes." });
      }

      // 6. All checks passed - save to spreadsheet
      sheet.appendRow([email, now.toISOString()]);
      const totalSignups = sheet.getLastRow() - 1;

      // Send notification - isolated so a failure here does not affect the signup
      try {
        MailApp.sendEmail(
          NOTIFICATION_EMAIL,
          'New Triad Signup #' + totalSignups,
          'New signup: ' + email + '\n\nTotal signups: ' + totalSignups
        );
      } catch (mailErr) {
        console.error('Email notification failed:', mailErr);
      }
    } finally {
      lock.releaseLock();
    }

    return jsonResponse({ result: 'success' });

  } catch (err) {
    console.error('doPost error:', err);
    return jsonResponse({ result: 'error', message: 'Something went wrong. Please try again shortly.' });
  }
}

function doGet() {
  return jsonResponse({ status: 'ok' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
