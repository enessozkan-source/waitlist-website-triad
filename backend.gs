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
 *      UMAMI_API_TOKEN    = your Umami Cloud API token (Settings > API Keys)
 *      UMAMI_WEBSITE_ID   = your Umami website ID (e.g. e7873232-7d4d-4475-adc1-17d9b083531b)
 * 2. Make sure your Google Sheet has headers in row 1: Email, Timestamp, Referral, Country
 * 3. Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone
 * 4. Run setupKeepWarm() once from the editor to install the 1-minute ping trigger.
 *    This keeps the script warm so users never hit a cold start.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MILESTONES = [100, 500, 1000, 5000, 10000];
const DISPLAY_OFFSET = 379;

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

    // 3b. Country code - 2 uppercase letters only
    const rawCountry = (params.country || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);

    // 4. reCAPTCHA verification (optional - skip if token missing)
    if (params.captcha_token) {
      const captchaResponse = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'post',
        payload: {
          secret: RECAPTCHA_SECRET,
          response: params.captcha_token
        }
      });
      const captchaResult = JSON.parse(captchaResponse.getContentText());
      if (!captchaResult.success || captchaResult.score < 0.3 || captchaResult.action !== 'submit') {
        return jsonResponse({ result: 'error', message: "We couldn't verify your submission. Please try again." });
      }
    }

    // 5-7. Acquire lock to prevent TOCTOU race on duplicate check and write
    let totalSignups = 0;
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Sheet1');
      const lastRow = sheet.getLastRow();

      // 5. Duplicate detection - read only email column (A) to minimize data transfer
      if (lastRow > 1) {
        const emails = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (let i = 0; i < emails.length; i++) {
          if (emails[i][0] && emails[i][0].toString().toLowerCase() === email) {
            return jsonResponse({ result: 'duplicate', message: "You're already on the list. See you at launch." });
          }
        }
      }

      // 6. All checks passed - write directly to next row (faster than appendRow)
      const now = new Date();
      const newRow = lastRow + 1;
      sheet.getRange(newRow, 1, 1, 4).setValues([[email, now.toISOString(), rawRef, rawCountry]]);
      totalSignups = newRow - 1;

      // Queue email notification for async sending via keepWarm trigger
      const pendingEmail = {
        email: email,
        ref: rawRef || 'direct',
        count: totalSignups
      };
      // Add milestone flag if applicable
      if (MILESTONES.indexOf(totalSignups) !== -1) {
        pendingEmail.milestone = true;
      }
      props.setProperty('PENDING_EMAIL', JSON.stringify(pendingEmail));
    } finally {
      lock.releaseLock();
    }

    return jsonResponse({ result: 'success', count: totalSignups + DISPLAY_OFFSET });

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
    try {
      return buildStatsPage(props);
    } catch (err) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:40px;color:#c00">Error loading stats. Check the server logs for details.</p>');
    }
  }

  // Public count endpoint for frontend display
  if (params.action === 'count') {
    try {
      const SPREADSHEET_ID = props.getProperty('SPREADSHEET_ID');
      const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Sheet1');
      const lastRow = sheet.getLastRow();
      const realCount = lastRow > 1 ? lastRow - 1 : 0;
      return jsonResponse({ count: realCount + DISPLAY_OFFSET });
    } catch (err) {
      return jsonResponse({ count: DISPLAY_OFFSET });
    }
  }

  // Error logging endpoint - receives frontend JS errors
  if (params.action === 'error') {
    try {
      const SPREADSHEET_ID = props.getProperty('SPREADSHEET_ID');
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      let errorSheet = ss.getSheetByName('Errors');
      if (!errorSheet) {
        errorSheet = ss.insertSheet('Errors');
        errorSheet.getRange(1, 1, 1, 6).setValues([['Timestamp', 'Message', 'Source', 'Line', 'UserAgent', 'URL']]);
      }
      const msg = (params.msg || '').slice(0, 300);
      const src = (params.src || '').slice(0, 200);
      const line = (params.line || '0') + ':' + (params.col || '0');
      const ua = (params.ua || '').slice(0, 150);
      const url = (params.url || '').slice(0, 200);
      errorSheet.appendRow([new Date().toISOString(), msg, src, line, ua, url]);
    } catch (err) {
      console.error('Error logging failed:', err);
    }
    return jsonResponse({ status: 'ok' });
  }

  // Default response used by keep-warm trigger
  return jsonResponse({ status: 'ok' });
}

/**
 * Fetch data from Umami Cloud API.
 * Returns parsed JSON or null on failure.
 */
function fetchUmami(endpoint, token) {
  try {
    var res = UrlFetchApp.fetch('https://api.umami.is/v1' + endpoint, {
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      return JSON.parse(res.getContentText());
    }
  } catch (err) {
    console.error('Umami API error:', err);
  }
  return null;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function buildStatsPage(props) {
  const SPREADSHEET_ID = props.getProperty('SPREADSHEET_ID');
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Sheet1');
  const data = sheet.getDataRange().getValues();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 86400000);
  const fourteenDaysAgo = new Date(todayStart.getTime() - 14 * 86400000);
  const thirtyDaysAgo = new Date(todayStart.getTime() - 30 * 86400000);
  const twentyFourHoursAgo = new Date(now.getTime() - 86400000);

  function toLocalKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  // 30-day daily counts
  const dailyCounts = {};
  for (let d = 29; d >= 0; d--) {
    dailyCounts[toLocalKey(new Date(todayStart.getTime() - d * 86400000))] = 0;
  }

  let total = 0, today = 0, yesterday = 0, last7 = 0, last30 = 0, prevWeekCount = 0;
  const refCounts = {}, countryCounts = {}, allDayCounts = {}, domainCounts = {};
  const hourlyCounts = new Array(24).fill(0);
  const velocitySlots = new Array(24).fill(0);
  let firstSignupDate = null;

  // Single-pass data loop
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    total++;
    const rowTime = new Date(data[i][1]);

    if (rowTime >= todayStart) today++;
    if (rowTime >= yesterdayStart && rowTime < todayStart) yesterday++;
    if (rowTime >= sevenDaysAgo) last7++;
    if (rowTime >= thirtyDaysAgo) last30++;
    if (rowTime >= fourteenDaysAgo && rowTime < sevenDaysAgo) prevWeekCount++;

    const dayKey = toLocalKey(rowTime);
    if (dailyCounts.hasOwnProperty(dayKey)) dailyCounts[dayKey]++;
    allDayCounts[dayKey] = (allDayCounts[dayKey] || 0) + 1;

    if (!firstSignupDate || rowTime < firstSignupDate) firstSignupDate = rowTime;
    hourlyCounts[rowTime.getHours()]++;

    if (rowTime >= twentyFourHoursAgo) {
      var hoursAgo = Math.floor((now.getTime() - rowTime.getTime()) / 3600000);
      if (hoursAgo >= 0 && hoursAgo < 24) velocitySlots[23 - hoursAgo]++;
    }

    var emailStr = (data[i][0] || '').toString().trim();
    var atIdx = emailStr.lastIndexOf('@');
    if (atIdx > 0) {
      var domain = emailStr.substring(atIdx + 1).toLowerCase();
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    }

    var ref = (data[i][2] || '').toString().trim() || 'direct';
    refCounts[ref] = (refCounts[ref] || 0) + 1;
    var cc = (data[i][3] || '').toString().trim().toUpperCase();
    if (cc.length === 2) countryCounts[cc] = (countryCounts[cc] || 0) + 1;
  }

  // Growth
  const growth = yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : null;
  const growthLabel = growth === null ? '' : (growth >= 0 ? '+' + growth + '% vs yesterday' : growth + '% vs yesterday');
  const growthColor = growth === null ? 'rgba(255,255,255,0.3)' : (growth >= 0 ? '#30D158' : '#ff453a');

  // Week over week
  var wowChange = prevWeekCount > 0 ? Math.round(((last7 - prevWeekCount) / prevWeekCount) * 100) : null;
  var wowLabel = wowChange === null ? 'N/A' : (wowChange >= 0 ? '+' + wowChange + '%' : wowChange + '%');
  var wowColor = wowChange === null ? 'rgba(255,255,255,0.3)' : (wowChange >= 0 ? '#30D158' : '#ff453a');

  // Average per day
  var avgPerDay = '0.0';
  if (firstSignupDate && total > 0) {
    var daysSinceFirst = Math.max(1, Math.ceil((now.getTime() - firstSignupDate.getTime()) / 86400000));
    avgPerDay = (total / daysSinceFirst).toFixed(1);
  }

  // Best day
  var MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var bestDayKey = '', bestDayCount = 0;
  Object.keys(allDayCounts).forEach(function(dk) {
    if (allDayCounts[dk] > bestDayCount) { bestDayCount = allDayCounts[dk]; bestDayKey = dk; }
  });
  var bestDayLabel = '';
  if (bestDayKey) {
    var bd = new Date(bestDayKey + 'T12:00:00');
    bestDayLabel = MONTH_NAMES[bd.getMonth()] + ' ' + bd.getDate();
  }

  // Milestone progress
  var nextMilestone = MILESTONES[MILESTONES.length - 1];
  var prevMilestone = 0;
  for (var m = 0; m < MILESTONES.length; m++) {
    if (total < MILESTONES[m]) { nextMilestone = MILESTONES[m]; prevMilestone = m > 0 ? MILESTONES[m - 1] : 0; break; }
  }
  var milestoneProgress = nextMilestone > prevMilestone
    ? Math.min(100, Math.round(((total - prevMilestone) / (nextMilestone - prevMilestone)) * 100))
    : 100;

  // Velocity sparkline
  var maxVel = Math.max.apply(null, velocitySlots.concat([1]));
  var sparkPoints = '';
  var sparkArea = '0,40 ';
  for (var h = 0; h < 24; h++) {
    var sx = Math.round((h / 23) * 240);
    var sy = Math.round(40 - (velocitySlots[h] / maxVel) * 36);
    sparkPoints += sx + ',' + sy + ' ';
    sparkArea += sx + ',' + sy + ' ';
  }
  sparkArea += '240,40';
  var velocityTotal = velocitySlots.reduce(function(a, b) { return a + b; }, 0);

  // Recent signups (last 15)
  var recentSignups = [];
  for (var ri = data.length - 1; ri >= 1 && recentSignups.length < 15; ri--) {
    if (!data[ri][0]) continue;
    var emailRaw = data[ri][0].toString().trim();
    var ts = new Date(data[ri][1]);
    var refVal = (data[ri][2] || '').toString().trim() || 'direct';
    var ccVal = (data[ri][3] || '').toString().trim().toUpperCase();
    var atPos = emailRaw.lastIndexOf('@');
    var masked = atPos > 1 ? emailRaw[0] + '***' + emailRaw.substring(atPos) : '***';
    var diffMin = Math.floor((now.getTime() - ts.getTime()) / 60000);
    var relTime;
    if (diffMin < 1) relTime = 'just now';
    else if (diffMin < 60) relTime = diffMin + 'm ago';
    else if (diffMin < 1440) relTime = Math.floor(diffMin / 60) + 'h ago';
    else relTime = Math.floor(diffMin / 1440) + 'd ago';
    recentSignups.push({ masked: masked, time: relTime, ref: refVal, cc: ccVal });
  }

  // Umami analytics
  var umamiToken = props.getProperty('UMAMI_API_TOKEN');
  var umamiSiteId = props.getProperty('UMAMI_WEBSITE_ID');
  var umami = { enabled: false };
  if (umamiToken && umamiSiteId) {
    var startAt7d = sevenDaysAgo.getTime();
    var startAtToday = todayStart.getTime();
    var startAtYesterday = yesterdayStart.getTime();
    var endAt = now.getTime();

    var stats7d = fetchUmami('/websites/' + umamiSiteId + '/stats?startAt=' + startAt7d + '&endAt=' + endAt, umamiToken);
    var statsToday = fetchUmami('/websites/' + umamiSiteId + '/stats?startAt=' + startAtToday + '&endAt=' + endAt, umamiToken);
    var statsYesterday = fetchUmami('/websites/' + umamiSiteId + '/stats?startAt=' + startAtYesterday + '&endAt=' + startAtToday, umamiToken);
    var umamiReferrers = fetchUmami('/websites/' + umamiSiteId + '/metrics?startAt=' + startAt7d + '&endAt=' + endAt + '&type=referrer', umamiToken);
    var umamiBrowsers = fetchUmami('/websites/' + umamiSiteId + '/metrics?startAt=' + startAt7d + '&endAt=' + endAt + '&type=browser', umamiToken);
    var umamiDevices = fetchUmami('/websites/' + umamiSiteId + '/metrics?startAt=' + startAt7d + '&endAt=' + endAt + '&type=device', umamiToken);
    var umamiEvents = fetchUmami('/websites/' + umamiSiteId + '/metrics?startAt=' + startAt7d + '&endAt=' + endAt + '&type=event', umamiToken);

    if (stats7d) {
      umami.enabled = true;
      // 7-day stats (all fields)
      umami.visitors7d = stats7d.visitors ? stats7d.visitors.value : 0;
      umami.pageviews7d = stats7d.pageviews ? stats7d.pageviews.value : 0;
      umami.bounces7d = stats7d.bounces ? stats7d.bounces.value : 0;
      umami.visits7d = stats7d.visits ? stats7d.visits.value : 0;
      umami.totaltime7d = stats7d.totaltime ? stats7d.totaltime.value : 0;
      umami.bounceRate7d = umami.visitors7d > 0 ? Math.round((umami.bounces7d / umami.visitors7d) * 100) : 0;
      umami.conversionRate7d = umami.visitors7d > 0 ? ((last7 / umami.visitors7d) * 100).toFixed(1) : '0.0';
      umami.pagesPerVisitor7d = umami.visitors7d > 0 ? (umami.pageviews7d / umami.visitors7d).toFixed(1) : '0.0';
      if (umami.visits7d > 0) {
        var avgSec = Math.round(umami.totaltime7d / umami.visits7d);
        umami.avgDuration7d = avgSec < 60 ? avgSec + 's' : Math.floor(avgSec / 60) + 'm ' + (avgSec % 60) + 's';
      } else {
        umami.avgDuration7d = '0s';
      }
      // Today stats (all fields)
      umami.visitorsToday = statsToday ? (statsToday.visitors ? statsToday.visitors.value : 0) : 0;
      umami.pageviewsToday = statsToday ? (statsToday.pageviews ? statsToday.pageviews.value : 0) : 0;
      umami.bouncesToday = statsToday ? (statsToday.bounces ? statsToday.bounces.value : 0) : 0;
      umami.visitsToday = statsToday ? (statsToday.visits ? statsToday.visits.value : 0) : 0;
      // Yesterday stats (all fields)
      umami.visitorsYesterday = statsYesterday ? (statsYesterday.visitors ? statsYesterday.visitors.value : 0) : 0;
      umami.pageviewsYesterday = statsYesterday ? (statsYesterday.pageviews ? statsYesterday.pageviews.value : 0) : 0;
      umami.bouncesYesterday = statsYesterday ? (statsYesterday.bounces ? statsYesterday.bounces.value : 0) : 0;
      umami.visitsYesterday = statsYesterday ? (statsYesterday.visits ? statsYesterday.visits.value : 0) : 0;
      // Metrics
      umami.referrers = umamiReferrers || [];
      umami.browsers = umamiBrowsers || [];
      umami.devices = umamiDevices || [];
      umami.events = umamiEvents || [];
    }
  }

  // Country names lookup
  var CN = {'US':'United States','GB':'United Kingdom','DE':'Germany','FR':'France','IN':'India','CA':'Canada',
    'AU':'Australia','TR':'Turkey','BR':'Brazil','JP':'Japan','CN':'China','KR':'South Korea',
    'NL':'Netherlands','ES':'Spain','IT':'Italy','RU':'Russia','PL':'Poland','SE':'Sweden',
    'NO':'Norway','DK':'Denmark','FI':'Finland','BE':'Belgium','CH':'Switzerland','AT':'Austria',
    'PT':'Portugal','IE':'Ireland','MX':'Mexico','AR':'Argentina','CO':'Colombia','CL':'Chile',
    'NG':'Nigeria','ZA':'South Africa','EG':'Egypt','KE':'Kenya','MA':'Morocco',
    'SA':'Saudi Arabia','AE':'UAE','IL':'Israel','IR':'Iran','PK':'Pakistan',
    'BD':'Bangladesh','VN':'Vietnam','TH':'Thailand','ID':'Indonesia','MY':'Malaysia',
    'PH':'Philippines','SG':'Singapore','HK':'Hong Kong','TW':'Taiwan','NZ':'New Zealand',
    'UA':'Ukraine','GR':'Greece','RO':'Romania','HU':'Hungary','CZ':'Czechia',
    'SK':'Slovakia','HR':'Croatia','RS':'Serbia'};

  function flag(cc) {
    if (!cc || cc.length !== 2) return '';
    return '&#' + (127397 + cc.charCodeAt(0)) + ';&#' + (127397 + cc.charCodeAt(1)) + ';';
  }

  // Country data - show ALL countries with percentages
  var topCountries = Object.keys(countryCounts).sort(function(a,b){return countryCounts[b]-countryCounts[a];});
  var maxCC = topCountries.length > 0 ? countryCounts[topCountries[0]] : 1;
  var countryCount = topCountries.length;
  var countryRows = topCountries.map(function(cc) {
    var count = countryCounts[cc];
    var pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    var barPct = Math.round((count / maxCC) * 100);
    var name = CN[cc] || cc;
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
      '<span style="font-size:18px;line-height:1;min-width:28px">' + flag(cc) + '</span>' +
      '<span style="flex:1;font-size:13px;color:rgba(255,255,255,0.8)">' + escHtml(name) + '</span>' +
      '<div style="width:80px;background:rgba(255,255,255,0.06);border-radius:999px;height:4px;margin-right:8px">' +
        '<div style="background:#30D158;height:4px;border-radius:999px;width:' + barPct + '%"></div>' +
      '</div>' +
      '<span style="font-size:12px;color:rgba(255,255,255,0.35);min-width:40px;text-align:right">' + pct + '%</span>' +
      '<span style="font-size:13px;font-weight:600;color:#30D158;min-width:28px;text-align:right">' + count + '</span>' +
    '</div>';
  }).join('');

  // 30-day bar chart
  var days = Object.keys(dailyCounts).sort();
  var maxBar = Math.max.apply(null, days.map(function(d){return dailyCounts[d];}).concat([1]));
  var CW = 28, BAR_W = 16, CHART_H = 100, BAR_MAX_H = 72;
  var bars = '';
  days.forEach(function(dayKey, i) {
    var count = dailyCounts[dayKey];
    var barH = count > 0 ? Math.max(Math.round((count / maxBar) * BAR_MAX_H), 4) : 2;
    var x = i * CW + (CW - BAR_W) / 2;
    var y = CHART_H - barH - 16;
    var isToday = i === days.length - 1;
    var fill = isToday ? '#30D158' : 'rgba(48,209,88,0.25)';
    bars += '<rect x="' + x + '" y="' + y + '" width="' + BAR_W + '" height="' + barH + '" rx="4" fill="' + fill + '"/>';
    if (isToday || count === maxBar) {
      bars += '<text x="' + (x + BAR_W/2) + '" y="' + (y - 3) + '" text-anchor="middle" style="font-size:9px;fill:rgba(255,255,255,0.5);font-family:-apple-system,sans-serif">' + count + '</text>';
    }
    if (i % 7 === 0 || isToday) {
      var date = new Date(dayKey + 'T12:00:00');
      var lbl = (date.getMonth() + 1) + '/' + date.getDate();
      bars += '<text x="' + (x + BAR_W/2) + '" y="' + (CHART_H - 2) + '" text-anchor="middle" style="font-size:8px;fill:rgba(255,255,255,0.25);font-family:-apple-system,sans-serif">' + lbl + '</text>';
    }
  });

  // Source rows
  var topRefs = Object.keys(refCounts).sort(function(a,b){return refCounts[b]-refCounts[a];}).slice(0, 8);
  var maxRef = topRefs.length > 0 ? refCounts[topRefs[0]] : 1;
  var sourceRows = topRefs.map(function(ref) {
    var count = refCounts[ref];
    var pct = total > 0 ? Math.round((count / total) * 100) : 0;
    var barPct = Math.round((count / maxRef) * 100);
    return '<div style="margin-bottom:14px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
        '<span style="font-size:13px;color:rgba(255,255,255,0.8)">' + escHtml(ref) + '</span>' +
        '<span style="font-size:13px;font-weight:600">' + count + ' <span style="color:rgba(255,255,255,0.3);font-weight:400">' + pct + '%</span></span>' +
      '</div>' +
      '<div style="background:rgba(255,255,255,0.06);border-radius:999px;height:4px">' +
        '<div style="background:#30D158;border-radius:999px;height:4px;width:' + barPct + '%"></div>' +
      '</div>' +
    '</div>';
  }).join('');

  // Hourly heatmap cells
  var maxHourly = Math.max.apply(null, hourlyCounts.concat([1]));
  var heatmapCells = '';
  for (var hh = 0; hh < 24; hh++) {
    var intensity = hourlyCounts[hh] / maxHourly;
    var alpha = Math.max(0.08, intensity * 0.9);
    var hbg = 'rgba(48,209,88,' + alpha.toFixed(2) + ')';
    heatmapCells += '<div style="flex:1;text-align:center">' +
      '<div style="background:' + hbg + ';border-radius:6px;height:32px;margin-bottom:4px;display:flex;align-items:center;justify-content:center">' +
        (hourlyCounts[hh] > 0 ? '<span style="font-size:9px;font-weight:600;color:' + (intensity > 0.5 ? '#fff' : 'rgba(255,255,255,0.5)') + '">' + hourlyCounts[hh] + '</span>' : '') +
      '</div>' +
      '<div style="font-size:7px;color:rgba(255,255,255,0.25)">' + (hh < 10 ? '0' : '') + hh + '</div>' +
    '</div>';
  }

  // Email domain rows
  var topDomains = Object.keys(domainCounts).sort(function(a, b) { return domainCounts[b] - domainCounts[a]; }).slice(0, 8);
  var maxDomain = topDomains.length > 0 ? domainCounts[topDomains[0]] : 1;
  var domainRows = topDomains.map(function(dom) {
    var count = domainCounts[dom];
    var pct = total > 0 ? Math.round((count / total) * 100) : 0;
    var barPct = Math.round((count / maxDomain) * 100);
    return '<div style="margin-bottom:14px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
        '<span style="font-size:13px;color:rgba(255,255,255,0.8)">' + escHtml(dom) + '</span>' +
        '<span style="font-size:13px;font-weight:600">' + count + ' <span style="color:rgba(255,255,255,0.3);font-weight:400">' + pct + '%</span></span>' +
      '</div>' +
      '<div style="background:rgba(255,255,255,0.06);border-radius:999px;height:4px">' +
        '<div style="background:#5e93ff;border-radius:999px;height:4px;width:' + barPct + '%"></div>' +
      '</div>' +
    '</div>';
  }).join('');

  // Recent signup table rows
  var recentRows = '';
  recentSignups.forEach(function(s) {
    recentRows += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">' +
      '<td style="padding:10px 0;font-size:13px;color:rgba(255,255,255,0.7);font-family:monospace">' + escHtml(s.masked) + '</td>' +
      '<td style="padding:10px 8px;font-size:12px;color:rgba(255,255,255,0.35)">' + escHtml(s.time) + '</td>' +
      '<td style="padding:10px 8px;font-size:12px;color:rgba(255,255,255,0.5)">' + escHtml(s.ref) + '</td>' +
      '<td style="padding:10px 0;font-size:14px;text-align:right">' + (s.cc ? flag(s.cc) : '') + '</td>' +
    '</tr>';
  });

  var updatedAt = now.toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  var countryDataJson = JSON.stringify(countryCounts);

  // ═══════════════════════════════════════
  // HTML
  // ═══════════════════════════════════════

  var html = '<!DOCTYPE html><html><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Triad Stats</title>' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:28px 20px;max-width:560px;margin:0 auto}' +
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}' +
    '@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}' +
    '.section{animation:fadeUp 0.4s ease both}' +
    '.scrollbox{max-height:400px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.1) transparent}' +
    '.scrollbox::-webkit-scrollbar{width:4px}.scrollbox::-webkit-scrollbar-track{background:transparent}.scrollbox::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:4px}' +
    '</style></head><body>' +

    // ── 1. Header ──
    '<div class="section" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px">' +
      '<div>' +
        '<div style="font-size:20px;font-weight:700;letter-spacing:-0.5px">Triad Waitlist</div>' +
        '<div style="font-size:12px;color:rgba(255,255,255,0.3);margin-top:3px">' +
          '<span style="display:inline-block;width:7px;height:7px;background:#30D158;border-radius:50%;margin-right:5px;animation:pulse 2s infinite"></span>' +
          'Updated ' + updatedAt +
          (countryCount > 0 ? ' &nbsp;&middot;&nbsp; ' + countryCount + ' countries' : '') +
        '</div>' +
      '</div>' +
    '</div>' +

    // ── 2. Total Signups ──
    '<div class="section" style="background:linear-gradient(135deg,#0d2818,#0a1510);border:1px solid rgba(48,209,88,0.2);border-radius:20px;padding:24px 28px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;animation-delay:0.05s">' +
      '<div>' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Total Signups</div>' +
        '<div style="font-size:60px;font-weight:800;color:#30D158;letter-spacing:-2px;line-height:1">' + total + '</div>' +
        '<div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:6px">people on the waitlist</div>' +
      '</div>' +
      '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" style="opacity:0.6"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="#30D158" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="7" r="4" stroke="#30D158" stroke-width="2"/><path d="M23 21v-2a4 4 0 0 0-3-3.87" stroke="#30D158" stroke-width="2" stroke-linecap="round"/><path d="M16 3.13a4 4 0 0 1 0 7.75" stroke="#30D158" stroke-width="2" stroke-linecap="round"/></svg>' +
    '</div>' +

    // ── 3. Milestone Progress ──
    '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px 20px;margin-bottom:14px;animation-delay:0.07s">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px">Next Milestone</div>' +
        '<div style="font-size:13px;font-weight:600;color:#30D158">' + total + ' / ' + nextMilestone + '</div>' +
      '</div>' +
      '<div style="background:rgba(255,255,255,0.06);border-radius:999px;height:8px;overflow:hidden">' +
        '<div style="background:linear-gradient(90deg,#30D158,#5e93ff);height:8px;border-radius:999px;width:' + milestoneProgress + '%"></div>' +
      '</div>' +
      '<div style="font-size:11px;color:rgba(255,255,255,0.25);margin-top:8px;text-align:center">' + milestoneProgress + '% to ' + nextMilestone + ' signups</div>' +
    '</div>' +

    // ── 4. Today / Yesterday / 7 Days ──
    '<div class="section" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px;animation-delay:0.1s">' +
      '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Today</div>' +
        '<div style="font-size:30px;font-weight:700;letter-spacing:-0.5px">' + today + '</div>' +
        '<div style="font-size:11px;margin-top:4px;color:' + growthColor + '">' + (growthLabel || 'no data') + '</div>' +
      '</div>' +
      '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Yesterday</div>' +
        '<div style="font-size:30px;font-weight:700;letter-spacing:-0.5px">' + yesterday + '</div>' +
        '<div style="font-size:11px;margin-top:4px;color:rgba(255,255,255,0.3)">baseline</div>' +
      '</div>' +
      '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">7 Days</div>' +
        '<div style="font-size:30px;font-weight:700;letter-spacing:-0.5px">' + last7 + '</div>' +
        '<div style="font-size:11px;margin-top:4px;color:rgba(255,255,255,0.3)">this week</div>' +
      '</div>' +
    '</div>' +

    // ── 5. Key Metrics (Avg/Day, Best Day, Week/Week) ──
    '<div class="section" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px;animation-delay:0.11s">' +
      '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Avg / Day</div>' +
        '<div style="font-size:26px;font-weight:700;letter-spacing:-0.5px;color:#5e93ff">' + avgPerDay + '</div>' +
        '<div style="font-size:11px;margin-top:4px;color:rgba(255,255,255,0.3)">all time</div>' +
      '</div>' +
      '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Best Day</div>' +
        '<div style="font-size:26px;font-weight:700;letter-spacing:-0.5px;color:#30D158">' + bestDayCount + '</div>' +
        '<div style="font-size:11px;margin-top:4px;color:rgba(255,255,255,0.3)">' + (bestDayLabel || 'n/a') + '</div>' +
      '</div>' +
      '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
        '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Week / Week</div>' +
        '<div style="font-size:26px;font-weight:700;letter-spacing:-0.5px;color:' + wowColor + '">' + wowLabel + '</div>' +
        '<div style="font-size:11px;margin-top:4px;color:rgba(255,255,255,0.3)">vs prev 7 days</div>' +
      '</div>' +
    '</div>' +

    // ── 6. Umami Site Traffic (enhanced) ──
    (umami.enabled ?
      '<div class="section" style="background:linear-gradient(135deg,#0d1828,#0a1015);border:1px solid rgba(94,147,255,0.2);border-radius:20px;padding:24px 28px;margin-bottom:14px;animation-delay:0.12s">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
          '<div style="font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px">Site Traffic (7 days)</div>' +
          '<div style="font-size:10px;color:rgba(94,147,255,0.5);background:rgba(94,147,255,0.1);padding:3px 8px;border-radius:999px">via Umami</div>' +
        '</div>' +
        // Row 1: Visitors, Pageviews, Sessions, Bounce Rate
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:12px">' +
          '<div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px">Visitors</div>' +
            '<div style="font-size:24px;font-weight:700;color:#5e93ff">' + umami.visitors7d + '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px">Pageviews</div>' +
            '<div style="font-size:24px;font-weight:700;color:#5e93ff">' + umami.pageviews7d + '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px">Sessions</div>' +
            '<div style="font-size:24px;font-weight:700;color:#5e93ff">' + umami.visits7d + '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px">Bounce</div>' +
            '<div style="font-size:24px;font-weight:700;color:' + (umami.bounceRate7d > 70 ? '#ff453a' : '#5e93ff') + '">' + umami.bounceRate7d + '%</div>' +
          '</div>' +
        '</div>' +
        // Row 2: Avg Duration, Pages/Visitor, Conversion
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">' +
          '<div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px">Avg Duration</div>' +
            '<div style="font-size:20px;font-weight:700;color:#5e93ff">' + umami.avgDuration7d + '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px">Pages / Visitor</div>' +
            '<div style="font-size:20px;font-weight:700;color:#5e93ff">' + umami.pagesPerVisitor7d + '</div>' +
          '</div>' +
          '<div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px">Conversion</div>' +
            '<div style="font-size:20px;font-weight:700;color:#30D158">' + umami.conversionRate7d + '%</div>' +
          '</div>' +
        '</div>' +
        // Today / Yesterday with full stats
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<div style="background:rgba(255,255,255,0.04);border-radius:12px;padding:12px">' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:8px">Today</div>' +
            '<div style="font-size:18px;font-weight:700;margin-bottom:4px">' + umami.visitorsToday + ' <span style="font-size:11px;font-weight:400;color:rgba(255,255,255,0.3)">visitors</span></div>' +
            '<div style="font-size:13px;color:rgba(255,255,255,0.5)">' + umami.pageviewsToday + ' <span style="font-size:11px;color:rgba(255,255,255,0.3)">pageviews</span></div>' +
            '<div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:2px">' + umami.visitsToday + ' <span style="font-size:11px;color:rgba(255,255,255,0.3)">sessions</span></div>' +
          '</div>' +
          '<div style="background:rgba(255,255,255,0.04);border-radius:12px;padding:12px">' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:8px">Yesterday</div>' +
            '<div style="font-size:18px;font-weight:700;margin-bottom:4px">' + umami.visitorsYesterday + ' <span style="font-size:11px;font-weight:400;color:rgba(255,255,255,0.3)">visitors</span></div>' +
            '<div style="font-size:13px;color:rgba(255,255,255,0.5)">' + umami.pageviewsYesterday + ' <span style="font-size:11px;color:rgba(255,255,255,0.3)">pageviews</span></div>' +
            '<div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:2px">' + umami.visitsYesterday + ' <span style="font-size:11px;color:rgba(255,255,255,0.3)">sessions</span></div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // ── 7. Umami Referrers + Devices + Browsers (3 columns) ──
      '<div class="section" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px;animation-delay:0.13s">' +
        '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
          '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px">Top Referrers</div>' +
          (umami.referrers.length > 0 ?
            umami.referrers.slice(0, 5).map(function(r) {
              return '<div style="display:flex;justify-content:space-between;margin-bottom:8px">' +
                '<span style="font-size:11px;color:rgba(255,255,255,0.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px">' + escHtml(r.x || 'direct') + '</span>' +
                '<span style="font-size:11px;font-weight:600;color:#5e93ff">' + r.y + '</span>' +
              '</div>';
            }).join('')
            : '<p style="font-size:11px;color:rgba(255,255,255,0.25)">No data yet</p>'
          ) +
        '</div>' +
        '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
          '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px">Devices</div>' +
          (umami.devices.length > 0 ?
            umami.devices.slice(0, 5).map(function(d) {
              var icon = d.x === 'mobile' ? '&#128241;' : (d.x === 'desktop' ? '&#128187;' : '&#128196;');
              return '<div style="display:flex;justify-content:space-between;margin-bottom:8px">' +
                '<span style="font-size:11px;color:rgba(255,255,255,0.7)">' + icon + ' ' + escHtml(d.x) + '</span>' +
                '<span style="font-size:11px;font-weight:600;color:#5e93ff">' + d.y + '</span>' +
              '</div>';
            }).join('')
            : '<p style="font-size:11px;color:rgba(255,255,255,0.25)">No data yet</p>'
          ) +
        '</div>' +
        '<div style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:16px">' +
          '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px">Browsers</div>' +
          (umami.browsers.length > 0 ?
            umami.browsers.slice(0, 5).map(function(b) {
              return '<div style="display:flex;justify-content:space-between;margin-bottom:8px">' +
                '<span style="font-size:11px;color:rgba(255,255,255,0.7)">' + escHtml(b.x) + '</span>' +
                '<span style="font-size:11px;font-weight:600;color:#5e93ff">' + b.y + '</span>' +
              '</div>';
            }).join('')
            : '<p style="font-size:11px;color:rgba(255,255,255,0.25)">No data yet</p>'
          ) +
        '</div>' +
      '</div>' +

      // ── 7b. User Engagement Funnel ──
      '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;margin-bottom:14px;animation-delay:0.135s">' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;margin-bottom:16px">User Engagement Funnel (7 days)</div>' +
        (function() {
          var evMap = {};
          (umami.events || []).forEach(function(ev) { evMap[ev.x] = ev.y; });
          var visits = umami.visitors7d || 0;
          var scrolled = evMap['scroll_depth'] || 0;
          var focused = evMap['email_focus'] || 0;
          var abandoned = evMap['form_abandon'] || 0;
          var errors = evMap['form_error'] || 0;
          var exits = evMap['page_exit'] || 0;
          var funnel = [
            { label: 'Visited', count: visits, color: '#5e93ff' },
            { label: 'Scrolled', count: scrolled, color: '#5e93ff' },
            { label: 'Focused Email', count: focused, color: '#30D158' },
            { label: 'Signed Up', count: last7, color: '#30D158' },
          ];
          var maxF = Math.max(visits, 1);
          var funnelHtml = funnel.map(function(step) {
            var pct = Math.round((step.count / maxF) * 100);
            var barW = Math.max(pct, 2);
            return '<div style="margin-bottom:12px">' +
              '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
                '<span style="font-size:12px;color:rgba(255,255,255,0.7)">' + step.label + '</span>' +
                '<span style="font-size:12px;font-weight:600;color:' + step.color + '">' + step.count + ' <span style="font-weight:400;color:rgba(255,255,255,0.3)">' + pct + '%</span></span>' +
              '</div>' +
              '<div style="background:rgba(255,255,255,0.06);border-radius:999px;height:6px">' +
                '<div style="background:' + step.color + ';border-radius:999px;height:6px;width:' + barW + '%;opacity:0.8"></div>' +
              '</div>' +
            '</div>';
          }).join('');
          if (abandoned > 0 || errors > 0) {
            funnelHtml += '<div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06)">' +
              '<div style="font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px">Drop-off Signals</div>';
            if (abandoned > 0) {
              funnelHtml += '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
                '<span style="font-size:12px;color:rgba(255,255,255,0.6)">Typed email but left</span>' +
                '<span style="font-size:12px;font-weight:600;color:#ff453a">' + abandoned + '</span>' +
              '</div>';
            }
            if (errors > 0) {
              funnelHtml += '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
                '<span style="font-size:12px;color:rgba(255,255,255,0.6)">Form errors</span>' +
                '<span style="font-size:12px;font-weight:600;color:#ff453a">' + errors + '</span>' +
              '</div>';
            }
            funnelHtml += '</div>';
          }
          return funnelHtml || '<p style="font-size:12px;color:rgba(255,255,255,0.25)">Collecting data. Events will appear after a few visits.</p>';
        })() +
      '</div>'
    : '') +

    // ── 8. Signup Velocity (24h) ──
    '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;margin-bottom:14px;animation-delay:0.14s">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px">Signup Velocity (24h)</div>' +
        '<div style="font-size:20px;font-weight:700;color:#30D158">' + velocityTotal + ' <span style="font-size:11px;font-weight:400;color:rgba(255,255,255,0.3)">signups</span></div>' +
      '</div>' +
      '<svg viewBox="0 0 240 40" width="100%" preserveAspectRatio="none" style="overflow:visible">' +
        '<polygon points="' + sparkArea + '" fill="rgba(48,209,88,0.15)"/>' +
        '<polyline points="' + sparkPoints.trim() + '" fill="none" stroke="#30D158" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>' +
    '</div>' +

    // ── 9. 30-Day Trend ──
    '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;margin-bottom:14px;animation-delay:0.15s">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px">Last 30 Days</div>' +
        '<div style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.5)">' + last30 + ' total</div>' +
      '</div>' +
      '<svg viewBox="0 0 840 100" width="100%" preserveAspectRatio="none" style="overflow:visible">' + bars + '</svg>' +
    '</div>' +

    // ── 10. Hourly Heatmap ──
    '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;margin-bottom:14px;animation-delay:0.17s">' +
      '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:16px">Signups by Hour</div>' +
      '<div style="display:flex;gap:3px">' + heatmapCells + '</div>' +
    '</div>' +

    // ── 11. Email Domains ──
    '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;margin-bottom:14px;animation-delay:0.19s">' +
      '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:16px">Email Providers</div>' +
      (domainRows || '<p style="font-size:13px;color:rgba(255,255,255,0.25)">No data yet.</p>') +
    '</div>' +

    // ── 12. Recent Signups ──
    '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;margin-bottom:14px;animation-delay:0.21s">' +
      '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:16px">Recent Signups</div>' +
      (recentRows ?
        '<div style="overflow-x:auto">' +
          '<table style="width:100%;border-collapse:collapse">' +
            '<thead><tr style="border-bottom:1px solid rgba(255,255,255,0.1)">' +
              '<th style="text-align:left;padding:0 0 8px;font-size:10px;color:rgba(255,255,255,0.25);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">Email</th>' +
              '<th style="text-align:left;padding:0 8px 8px;font-size:10px;color:rgba(255,255,255,0.25);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">When</th>' +
              '<th style="text-align:left;padding:0 8px 8px;font-size:10px;color:rgba(255,255,255,0.25);font-weight:500;text-transform:uppercase;letter-spacing:0.5px">Source</th>' +
              '<th style="text-align:right;padding:0 0 8px;font-size:10px;color:rgba(255,255,255,0.25);font-weight:500;text-transform:uppercase;letter-spacing:0.5px"></th>' +
            '</tr></thead>' +
            '<tbody>' + recentRows + '</tbody>' +
          '</table>' +
        '</div>'
        : '<p style="font-size:13px;color:rgba(255,255,255,0.25)">No signups yet.</p>'
      ) +
    '</div>' +

    // ── 13. World Map + Country List (improved) ──
    '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;margin-bottom:14px;animation-delay:0.23s">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px">Global Reach</div>' +
        '<div style="font-size:12px;color:rgba(255,255,255,0.4)">' + countryCount + ' countries &middot; ' + total + ' signups</div>' +
      '</div>' +
      '<div id="map-wrap" style="position:relative;background:#0d1f12;border-radius:10px;overflow:hidden;margin-bottom:' + (countryRows ? '20px' : '0') + '">' +
        '<svg id="world-svg" style="width:100%;display:block"></svg>' +
        '<div id="map-tip" style="display:none;position:absolute;background:rgba(10,25,15,0.97);border:1px solid rgba(48,209,88,0.4);border-radius:8px;padding:6px 12px;font-size:12px;color:#30D158;pointer-events:none;white-space:nowrap;z-index:10"></div>' +
      '</div>' +
      (countryRows ?
        '<div class="scrollbox">' + countryRows + '</div>'
        : '<p style="font-size:13px;color:rgba(255,255,255,0.25)">No location data yet. Will appear with new signups.</p>'
      ) +
    '</div>' +

    // ── 14. Top Sources ──
    '<div class="section" style="background:#141414;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px;animation-delay:0.25s">' +
      '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:16px">Top Sources</div>' +
      (sourceRows || '<p style="font-size:13px;color:rgba(255,255,255,0.25)">No referral data yet.</p>') +
    '</div>' +

    // ── 15. Recent JS Errors ──
    (function() {
      try {
        var errSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Errors');
        if (!errSheet || errSheet.getLastRow() <= 1) return '';
        var lastErrRow = errSheet.getLastRow();
        var startRow = Math.max(2, lastErrRow - 9);
        var errData = errSheet.getRange(startRow, 1, lastErrRow - startRow + 1, 6).getValues();
        var errRows = '';
        for (var ei = errData.length - 1; ei >= 0; ei--) {
          var eTs = new Date(errData[ei][0]);
          var eDiff = Math.floor((now.getTime() - eTs.getTime()) / 60000);
          var eTime = eDiff < 60 ? eDiff + 'm ago' : (eDiff < 1440 ? Math.floor(eDiff / 60) + 'h ago' : Math.floor(eDiff / 1440) + 'd ago');
          errRows += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">' +
            '<td style="padding:8px 0;font-size:11px;color:rgba(255,255,255,0.4)">' + escHtml(eTime) + '</td>' +
            '<td style="padding:8px 8px;font-size:11px;color:#ff453a;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(errData[ei][1]) + '</td>' +
            '<td style="padding:8px 0;font-size:10px;color:rgba(255,255,255,0.3);text-align:right">' + escHtml(errData[ei][3]) + '</td>' +
          '</tr>';
        }
        var totalErrors = lastErrRow - 1;
        return '<div class="section" style="background:#141414;border:1px solid rgba(255,69,58,0.15);border-radius:16px;padding:20px;margin-bottom:14px;animation-delay:0.27s">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
            '<div style="font-size:11px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.8px">JS Errors</div>' +
            '<div style="font-size:12px;color:#ff453a;font-weight:600">' + totalErrors + ' total</div>' +
          '</div>' +
          '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">' +
            '<thead><tr style="border-bottom:1px solid rgba(255,255,255,0.1)">' +
              '<th style="text-align:left;padding:0 0 8px;font-size:10px;color:rgba(255,255,255,0.25);font-weight:500">When</th>' +
              '<th style="text-align:left;padding:0 8px 8px;font-size:10px;color:rgba(255,255,255,0.25);font-weight:500">Error</th>' +
              '<th style="text-align:right;padding:0 0 8px;font-size:10px;color:rgba(255,255,255,0.25);font-weight:500">Line</th>' +
            '</tr></thead>' +
            '<tbody>' + errRows + '</tbody>' +
          '</table></div>' +
        '</div>';
      } catch (_) { return ''; }
    })() +

    '<p style="margin-top:24px;font-size:11px;color:rgba(255,255,255,0.12);text-align:center">Triad - Internal use only</p>' +

    // D3 world map scripts
    '<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>' +
    '<script src="https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js"></script>' +
    '<script>' +
    'var CDATA=' + countryDataJson + ';' +
    'var N2A={4:"AF",8:"AL",12:"DZ",24:"AO",32:"AR",36:"AU",40:"AT",50:"BD",56:"BE",64:"BT",68:"BO",76:"BR",100:"BG",116:"KH",124:"CA",144:"LK",152:"CL",156:"CN",158:"TW",170:"CO",191:"HR",196:"CY",203:"CZ",208:"DK",231:"ET",246:"FI",250:"FR",266:"GA",276:"DE",288:"GH",300:"GR",320:"GT",344:"HK",348:"HU",356:"IN",360:"ID",364:"IR",368:"IQ",376:"IL",380:"IT",388:"JM",392:"JP",398:"KZ",404:"KE",410:"KR",418:"LA",422:"LB",458:"MY",484:"MX",504:"MA",516:"NA",524:"NP",528:"NL",554:"NZ",566:"NG",578:"NO",586:"PK",608:"PH",616:"PL",620:"PT",634:"QA",642:"RO",643:"RU",682:"SA",688:"RS",702:"SG",703:"SK",710:"ZA",724:"ES",752:"SE",756:"CH",764:"TH",792:"TR",804:"UA",784:"AE",826:"GB",840:"US",858:"UY",862:"VE",704:"VN",372:"IE",232:"ER",270:"GM",324:"GN",384:"CI",466:"ML",562:"NE",686:"SN",694:"SL",768:"TG",204:"BJ",800:"UG",706:"SO",716:"ZW",894:"ZM"};' +
    'var CNAMES={"US":"United States","GB":"United Kingdom","DE":"Germany","FR":"France","IN":"India","CA":"Canada","AU":"Australia","TR":"Turkey","BR":"Brazil","JP":"Japan","CN":"China","KR":"South Korea","NL":"Netherlands","ES":"Spain","IT":"Italy","RU":"Russia","PL":"Poland","SE":"Sweden","NO":"Norway","DK":"Denmark","FI":"Finland","BE":"Belgium","CH":"Switzerland","AT":"Austria","PT":"Portugal","IE":"Ireland","MX":"Mexico","AR":"Argentina","CO":"Colombia","CL":"Chile","NG":"Nigeria","ZA":"South Africa","EG":"Egypt","KE":"Kenya","MA":"Morocco","SA":"Saudi Arabia","AE":"UAE","IL":"Israel","IR":"Iran","PK":"Pakistan","BD":"Bangladesh","VN":"Vietnam","TH":"Thailand","ID":"Indonesia","MY":"Malaysia","PH":"Philippines","SG":"Singapore","HK":"Hong Kong","TW":"Taiwan","NZ":"New Zealand","UA":"Ukraine","GR":"Greece","RO":"Romania","HU":"Hungary","CZ":"Czechia","SK":"Slovakia","HR":"Croatia","RS":"Serbia"};' +
    '(function(){' +
      'var wrap=document.getElementById("map-wrap");' +
      'var svg=d3.select("#world-svg");' +
      'var W=wrap.offsetWidth||520;' +
      'var H=Math.round(W*0.52);' +
      'svg.attr("viewBox","0 0 "+W+" "+H).attr("height",H);' +
      'var proj=d3.geoNaturalEarth1().scale(W/6.3).translate([W/2,H/2]);' +
      'var gpath=d3.geoPath().projection(proj);' +
      'var maxCount=Object.keys(CDATA).length>0?Math.max.apply(null,Object.keys(CDATA).map(function(k){return CDATA[k];})):1;' +
      'svg.append("path").datum({type:"Sphere"}).attr("d",gpath).attr("fill","#0d1f12").attr("stroke","rgba(48,209,88,0.1)").attr("stroke-width","0.5");' +
      'svg.append("path").datum(d3.geoGraticule()()).attr("d",gpath).attr("fill","none").attr("stroke","rgba(255,255,255,0.03)").attr("stroke-width","0.5");' +
      'd3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then(function(world){' +
        'var countries=topojson.feature(world,world.objects.countries);' +
        'svg.selectAll(".cy").data(countries.features).enter().append("path")' +
          '.attr("class","cy").attr("d",gpath)' +
          '.attr("fill",function(d){var a=N2A[+d.id];return(a&&CDATA[a])?"#1a4a28":"#162a1c";})' +
          '.attr("stroke","rgba(48,209,88,0.2)").attr("stroke-width","0.4");' +
        'countries.features.forEach(function(f){' +
          'var a=N2A[+f.id];' +
          'if(!a||!CDATA[a])return;' +
          'var cnt=CDATA[a];' +
          'var c=gpath.centroid(f);' +
          'if(!c||isNaN(c[0])||isNaN(c[1]))return;' +
          'var r=Math.max(4,Math.min(14,4+(cnt/maxCount)*10));' +
          'var ring=svg.append("circle").attr("cx",c[0]).attr("cy",c[1]).attr("r",r).attr("fill","none").attr("stroke","#30D158").attr("stroke-width","1.2").attr("opacity","0.6");' +
          'ring.append("animate").attr("attributeName","r").attr("from",r).attr("to",r*2.8).attr("dur","2.5s").attr("repeatCount","indefinite");' +
          'ring.append("animate").attr("attributeName","opacity").attr("from","0.6").attr("to","0").attr("dur","2.5s").attr("repeatCount","indefinite");' +
          'svg.append("circle").attr("cx",c[0]).attr("cy",c[1]).attr("r",r*0.38).attr("fill","#30D158");' +
        '});' +
        'var tip=document.getElementById("map-tip");' +
        'svg.selectAll(".cy")' +
          '.on("mousemove",function(event,d){' +
            'var a=N2A[+d.id];' +
            'if(!a||!CDATA[a]){tip.style.display="none";return;}' +
            'tip.style.display="block";' +
            'tip.textContent=(CNAMES[a]||a)+": "+CDATA[a]+" signup"+(CDATA[a]>1?"s":"");' +
            'var rect=wrap.getBoundingClientRect();' +
            'var ex=event.clientX-rect.left,ey=event.clientY-rect.top;' +
            'tip.style.left=Math.min(ex+12,wrap.offsetWidth-160)+"px";' +
            'tip.style.top=Math.max(ey-34,4)+"px";' +
          '})' +
          '.on("mouseleave",function(){tip.style.display="none";});' +
      '}).catch(function(){' +
        'document.getElementById("map-wrap").style.display="none";' +
      '});' +
    '})();' +
    '</script>' +
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
  // Send any queued email notifications
  const props = PropertiesService.getScriptProperties();
  const pending = props.getProperty('PENDING_EMAIL');
  if (pending) {
    props.deleteProperty('PENDING_EMAIL');
    try {
      const data = JSON.parse(pending);
      const NOTIFICATION_EMAIL = props.getProperty('NOTIFICATION_EMAIL');

      // Per-signup notification
      MailApp.sendEmail(
        NOTIFICATION_EMAIL,
        'New Triad Signup #' + data.count,
        'New signup: ' + data.email +
        '\nSource: ' + data.ref +
        '\n\nTotal signups: ' + data.count
      );

      // Milestone notification
      if (data.milestone) {
        MailApp.sendEmail(
          NOTIFICATION_EMAIL,
          'Triad just hit ' + data.count + ' signups!',
          'Milestone reached: ' + data.count + ' people on the Triad waitlist.\n\nLatest signup: ' + data.email + '\nSource: ' + data.ref
        );
      }
    } catch (err) {
      console.error('Email send failed:', err);
    }
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
