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
 *      STATS_KEY          = a secret key for the stats dashboard (you choose this)
 * 2. Make sure your Google Sheet has headers in row 1: Email, Timestamp, Referral
 * 3. Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone
 * 4. Run setupKeepWarm() once from the editor to install the 1-minute ping trigger.
 *    This keeps the script warm so users never hit a cold start.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MILESTONES = [100, 500, 1000, 5000, 10000];

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

    // 3. Referral source - sanitize to 50 chars max, alphanumeric and hyphens only
    const rawRef = (params.ref || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 50);

    // 4. reCAPTCHA verification (mandatory)
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

    // 5-7. Acquire lock to prevent TOCTOU race on duplicate check and write
    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getActiveSheet();
      const data = sheet.getDataRange().getValues();

      // 5. Duplicate detection
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString().toLowerCase() === email) {
          return jsonResponse({ result: 'duplicate', message: "You're already on the list. See you at launch." });
        }
      }

      // 6. Rate limiting - scan from bottom since rows are appended in order
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

      // 7. All checks passed - save to spreadsheet (Email, Timestamp, Referral)
      sheet.appendRow([email, now.toISOString(), rawRef]);
      const totalSignups = sheet.getLastRow() - 1;

      // Per-signup notification - isolated so failure does not affect the signup
      try {
        MailApp.sendEmail(
          NOTIFICATION_EMAIL,
          'New Triad Signup #' + totalSignups,
          'New signup: ' + email +
          '\nSource: ' + (rawRef || 'direct') +
          '\n\nTotal signups: ' + totalSignups
        );
      } catch (mailErr) {
        console.error('Email notification failed:', mailErr);
      }

      // Milestone notification - special alert at key signup counts
      if (MILESTONES.indexOf(totalSignups) !== -1) {
        try {
          MailApp.sendEmail(
            NOTIFICATION_EMAIL,
            'Triad just hit ' + totalSignups + ' signups!',
            'Milestone reached: ' + totalSignups + ' people on the Triad waitlist.\n\nLatest signup: ' + email + '\nSource: ' + (rawRef || 'direct')
          );
        } catch (milestoneErr) {
          console.error('Milestone email failed:', milestoneErr);
        }
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

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const props = PropertiesService.getScriptProperties();

  // Stats dashboard - requires secret key
  if (params.action === 'stats') {
    const STATS_KEY = props.getProperty('STATS_KEY');
    if (!STATS_KEY || params.key !== STATS_KEY) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:40px;color:#888">Unauthorized.</p>');
    }
    return buildStatsPage(props);
  }

  // Default response used by keep-warm trigger
  return jsonResponse({ status: 'ok' });
}

function buildStatsPage(props) {
  const SPREADSHEET_ID = props.getProperty('SPREADSHEET_ID');
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getActiveSheet();
  const data = sheet.getDataRange().getValues();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  let total = 0;
  let today = 0;
  let last7 = 0;
  const refCounts = {};

  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    total++;
    const rowTime = new Date(data[i][1]);
    if (rowTime >= todayStart) today++;
    if (rowTime >= sevenDaysAgo) last7++;
    const ref = (data[i][2] || '').toString().trim() || 'direct';
    refCounts[ref] = (refCounts[ref] || 0) + 1;
  }

  // Sort referral sources by count descending
  const topRefs = Object.keys(refCounts)
    .sort(function(a, b) { return refCounts[b] - refCounts[a]; })
    .slice(0, 10);

  const refRows = topRefs.map(function(ref) {
    const pct = total > 0 ? Math.round((refCounts[ref] / total) * 100) : 0;
    return '<div class="ref-row"><span class="ref-name">' + ref + '</span>' +
           '<span class="ref-right"><span class="ref-pct">' + pct + '%</span>' +
           '<span class="ref-count">' + refCounts[ref] + '</span></span></div>';
  }).join('');

  const updatedAt = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const html = '<!DOCTYPE html><html><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Triad Stats</title>' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:32px 20px;max-width:480px;margin:0 auto}' +
    'h1{font-size:22px;font-weight:700;letter-spacing:-0.5px}' +
    '.sub{color:rgba(255,255,255,0.35);font-size:13px;margin-top:4px;margin-bottom:28px}' +
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:28px}' +
    '.card{background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:18px}' +
    '.card.full{grid-column:1/-1}' +
    '.card .label{font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px}' +
    '.card .value{font-size:40px;font-weight:700;letter-spacing:-1px}' +
    '.card.full .value{font-size:52px;color:#30D158}' +
    '.card .value.sm{font-size:32px}' +
    'h2{font-size:11px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px}' +
    '.ref-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05)}' +
    '.ref-row:last-child{border-bottom:none}' +
    '.ref-name{color:rgba(255,255,255,0.75);font-size:14px}' +
    '.ref-right{display:flex;align-items:center;gap:12px}' +
    '.ref-pct{color:rgba(255,255,255,0.3);font-size:13px}' +
    '.ref-count{font-weight:600;font-size:14px;min-width:28px;text-align:right}' +
    '.footer{margin-top:32px;font-size:12px;color:rgba(255,255,255,0.15);text-align:center}' +
    '</style></head><body>' +
    '<h1>Triad Waitlist</h1>' +
    '<p class="sub">Updated ' + updatedAt + '</p>' +
    '<div class="grid">' +
    '<div class="card full"><div class="label">Total Signups</div><div class="value">' + total + '</div></div>' +
    '<div class="card"><div class="label">Today</div><div class="value sm">' + today + '</div></div>' +
    '<div class="card"><div class="label">Last 7 Days</div><div class="value sm">' + last7 + '</div></div>' +
    '</div>' +
    '<h2>Top Sources</h2>' +
    (refRows || '<p style="color:rgba(255,255,255,0.3);font-size:14px">No data yet.</p>') +
    '<p class="footer">Triad - Internal use only</p>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html).setTitle('Triad Stats');
}

// Run this function once from the Apps Script editor to install the keep-warm trigger.
// It removes any existing keepWarm triggers first to avoid duplicates.
function setupKeepWarm() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'keepWarm'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('keepWarm')
    .timeBased()
    .everyMinutes(1)
    .create();
}

function keepWarm() {
  // Intentionally empty. Existence of this execution keeps the VM alive.
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
