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
 * 2. Make sure your Google Sheet has headers in row 1: Email, Timestamp, Referral, Country
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

    // 3b. Country code - 2 uppercase letters only
    const rawCountry = (params.country || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);

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

      // 6. Rate limiting - read only last 50 rows of timestamp column (B)
      const now = new Date();
      if (lastRow > 1) {
        const rateStart = Math.max(2, lastRow - 49);
        const rateRows = lastRow - rateStart + 1;
        const timestamps = sheet.getRange(rateStart, 2, rateRows, 1).getValues();
        const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
        let recentCount = 0;
        for (let j = timestamps.length - 1; j >= 0; j--) {
          const rowTime = new Date(timestamps[j][0]);
          if (isNaN(rowTime) || rowTime < tenMinutesAgo) break;
          recentCount++;
        }
        if (recentCount > 20) {
          return jsonResponse({ result: 'error', message: "We're seeing a lot of signups right now. Try again in a few minutes." });
        }
      }

      // 7. All checks passed - write directly to next row (faster than appendRow)
      const newRow = lastRow + 1;
      sheet.getRange(newRow, 1, 1, 4).setValues([[email, now.toISOString(), rawRef, rawCountry]]);
      const totalSignups = newRow - 1;

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
    try {
      return buildStatsPage(props);
    } catch (err) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:40px;color:#c00">Error loading stats: ' + err.message + '</p>');
    }
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
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  function toLocalKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  const dailyCounts = {};
  for (let d = 6; d >= 0; d--) {
    dailyCounts[toLocalKey(new Date(todayStart.getTime() - d * 24 * 60 * 60 * 1000))] = 0;
  }

  let total = 0, today = 0, yesterday = 0, last7 = 0;
  const refCounts = {}, countryCounts = {};

  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    total++;
    const rowTime = new Date(data[i][1]);
    if (rowTime >= todayStart) today++;
    if (rowTime >= yesterdayStart && rowTime < todayStart) yesterday++;
    if (rowTime >= sevenDaysAgo) last7++;
    const dayKey = toLocalKey(rowTime);
    if (dailyCounts.hasOwnProperty(dayKey)) dailyCounts[dayKey]++;
    const ref = (data[i][2] || '').toString().trim() || 'direct';
    refCounts[ref] = (refCounts[ref] || 0) + 1;
    const cc = (data[i][3] || '').toString().trim().toUpperCase();
    if (cc.length === 2) countryCounts[cc] = (countryCounts[cc] || 0) + 1;
  }

  const growth = yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : null;
  const growthLabel = growth === null ? 'first day' : (growth >= 0 ? '+' + growth + '%' : growth + '%');
  const growthColor = growth === null ? '#00d4ff' : (growth >= 0 ? '#00ff88' : '#ff4d4d');

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

  // Country lat/lng to SVG x,y (viewBox 1000x500 equirectangular)
  var CPOS = {
    'US':[231,144],'CA':[184,86],'MX':[194,210],'BR':[294,294],'AR':[263,361],
    'CO':[228,242],'CL':[255,341],'PE':[234,281],'VE':[240,222],
    'GB':[492,97],'IE':[473,100],'FR':[498,119],'DE':[528,100],'IT':[531,133],
    'ES':[458,133],'PT':[444,136],'NL':[499,93],'BE':[498,100],'SE':[544,68],
    'NO':[528,60],'DK':[527,83],'FI':[565,61],'PL':[545,97],'CZ':[535,100],
    'RO':[561,113],'UA':[565,103],'TR':[597,131],'RU':[708,78],'GR':[554,137],
    'HU':[544,108],'CH':[505,108],'AT':[532,108],'SK':[540,102],'HR':[534,114],
    'RS':[549,113],'CN':[792,153],'JP':[883,150],'KR':[819,138],'IN':[715,194],
    'PK':[659,165],'BD':[715,176],'VN':[775,210],'TH':[760,199],'ID':[786,255],
    'MY':[763,229],'PH':[801,210],'SG':[769,247],'AU':[869,325],'NZ':[877,366],
    'HK':[784,184],'TW':[803,183],'NG':[497,241],'ZA':[522,353],'EG':[554,168],
    'KE':[565,252],'MA':[458,163],'ET':[571,243],'GH':[474,252],
    'SA':[599,192],'AE':[617,193],'IL':[562,165],'IR':[633,160],'IQ':[609,157]};

  // Flag emoji from country code
  function flag(cc) {
    if (!cc || cc.length !== 2) return '';
    return '&#' + (127397 + cc.charCodeAt(0)) + ';&#' + (127397 + cc.charCodeAt(1)) + ';';
  }

  // Build world map dots
  var topCountries = Object.keys(countryCounts).sort(function(a,b){return countryCounts[b]-countryCounts[a];});
  var maxCC = topCountries.length > 0 ? countryCounts[topCountries[0]] : 1;
  var mapDots = '';
  topCountries.forEach(function(cc) {
    var pos = CPOS[cc];
    if (!pos) return;
    var r = Math.max(4, Math.min(14, 4 + (countryCounts[cc] / maxCC) * 10));
    mapDots += '<circle cx="' + pos[0] + '" cy="' + pos[1] + '" r="' + r + '" fill="rgba(0,255,136,0.15)" stroke="#00ff88" stroke-width="1.5"/>' +
               '<circle cx="' + pos[0] + '" cy="' + pos[1] + '" r="' + (r * 0.35) + '" fill="#00ff88"/>';
  });

  // Grid lines for world map
  var gridLines = '';
  for (var gx = 0; gx <= 1000; gx += 100) {
    gridLines += '<line x1="' + gx + '" y1="0" x2="' + gx + '" y2="500" stroke="rgba(0,255,136,0.06)" stroke-width="1"/>';
  }
  for (var gy = 0; gy <= 500; gy += 100) {
    var sw = gy === 250 ? '1.5' : '1';
    var sc = gy === 250 ? 'rgba(0,255,136,0.15)' : 'rgba(0,255,136,0.06)';
    gridLines += '<line x1="0" y1="' + gy + '" x2="1000" y2="' + gy + '" stroke="' + sc + '" stroke-width="' + sw + '"/>';
  }
  // Prime meridian
  gridLines += '<line x1="500" y1="0" x2="500" y2="500" stroke="rgba(0,255,136,0.12)" stroke-width="1" stroke-dasharray="4,4"/>';

  // Country list rows
  var countryRows = topCountries.slice(0, 10).map(function(cc) {
    var count = countryCounts[cc];
    var pct = total > 0 ? Math.round((count / maxCC) * 100) : 0;
    var name = CN[cc] || cc;
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(0,255,136,0.06)">' +
      '<span style="font-size:18px;line-height:1">' + flag(cc) + '</span>' +
      '<span style="flex:1;font-size:13px;color:rgba(255,255,255,0.75);font-family:Courier New,monospace">' + name + '</span>' +
      '<div style="width:80px;background:rgba(0,255,136,0.08);border-radius:2px;height:3px;margin-right:8px">' +
        '<div style="background:#00ff88;height:3px;border-radius:2px;width:' + pct + '%"></div>' +
      '</div>' +
      '<span style="font-size:13px;font-weight:700;color:#00ff88;font-family:Courier New,monospace;min-width:24px;text-align:right">' + count + '</span>' +
    '</div>';
  }).join('');

  // Bar chart
  const days = Object.keys(dailyCounts).sort();
  const DAY_NAMES = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const maxBar = Math.max.apply(null, days.map(function(d){return dailyCounts[d];}).concat([1]));
  var bars = '';
  days.forEach(function(dayKey, i) {
    var count = dailyCounts[dayKey];
    var barH = count > 0 ? Math.max(Math.round((count / maxBar) * 70), 6) : 3;
    var x = i * 100 + 20;
    var y = 80 - barH;
    var isToday = i === 6;
    var date = new Date(dayKey + 'T12:00:00');
    var label = DAY_NAMES[date.getDay()];
    if (isToday) {
      bars += '<rect x="' + x + '" y="' + y + '" width="60" height="' + barH + '" rx="4" fill="url(#bg)"/>';
    } else {
      bars += '<rect x="' + x + '" y="' + y + '" width="60" height="' + barH + '" rx="4" fill="rgba(0,255,136,0.2)"/>';
    }
    if (count > 0) bars += '<text x="' + (x+30) + '" y="' + (y-6) + '" text-anchor="middle" fill="rgba(0,255,136,0.7)" style="font-size:10px;font-family:Courier New,monospace">' + count + '</text>';
    bars += '<text x="' + (x+30) + '" y="98" text-anchor="middle" fill="' + (isToday ? '#00ff88' : 'rgba(0,255,136,0.35)') + '" style="font-size:10px;font-family:Courier New,monospace;font-weight:' + (isToday?'700':'400') + '">' + label + '</text>';
  });

  // Source rows
  var topRefs = Object.keys(refCounts).sort(function(a,b){return refCounts[b]-refCounts[a];}).slice(0,8);
  var maxRef = topRefs.length > 0 ? refCounts[topRefs[0]] : 1;
  var sourceRows = topRefs.map(function(ref) {
    var count = refCounts[ref];
    var pct = total > 0 ? Math.round((count / total) * 100) : 0;
    var barPct = Math.round((count / maxRef) * 100);
    return '<div style="margin-bottom:12px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:5px">' +
        '<span style="font-size:12px;color:rgba(0,255,136,0.7);font-family:Courier New,monospace">' + ref.toUpperCase() + '</span>' +
        '<span style="font-size:12px;font-family:Courier New,monospace;color:#00ff88">' + count + ' <span style="color:rgba(0,255,136,0.4)">[' + pct + '%]</span></span>' +
      '</div>' +
      '<div style="background:rgba(0,255,136,0.08);border-radius:1px;height:3px">' +
        '<div style="background:linear-gradient(90deg,#00ff88,#00d4ff);height:3px;border-radius:1px;width:' + barPct + '%"></div>' +
      '</div>' +
    '</div>';
  }).join('');

  var ts = now.toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  var countryCount = Object.keys(countryCounts).length;

  var html = '<!DOCTYPE html><html><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>TRIAD // INTELLIGENCE DASHBOARD</title>' +
    '<style>' +
    ':root{--g:#00ff88;--c:#00d4ff;--o:#ff6b35;--bg:#020805}' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{background:var(--bg);color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px 20px;max-width:640px;margin:0 auto;' +
      'background-image:linear-gradient(rgba(0,255,136,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,136,0.025) 1px,transparent 1px);' +
      'background-size:40px 40px}' +
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.2}}' +
    '@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}' +
    '@keyframes scan{0%{top:-2px}100%{top:100%}}' +
    '@keyframes blink{0%,100%{opacity:1}49%{opacity:1}50%,99%{opacity:0}}' +
    '@keyframes glow{0%,100%{text-shadow:0 0 20px var(--g),0 0 40px rgba(0,255,136,0.4)}50%{text-shadow:0 0 30px var(--g),0 0 60px rgba(0,255,136,0.6)}}' +
    '.f{animation:fadeUp 0.5s ease both}' +
    '.hc{background:rgba(0,15,8,0.9);border:1px solid rgba(0,255,136,0.2);border-radius:6px;position:relative;padding:16px;' +
      'box-shadow:0 0 20px rgba(0,255,136,0.05),inset 0 0 40px rgba(0,255,136,0.02)}' +
    '.hc::before{content:"";position:absolute;top:-1px;left:-1px;width:12px;height:12px;border-top:2px solid var(--g);border-left:2px solid var(--g)}' +
    '.hc::after{content:"";position:absolute;bottom:-1px;right:-1px;width:12px;height:12px;border-bottom:2px solid var(--g);border-right:2px solid var(--g)}' +
    '.lbl{font-size:9px;color:rgba(0,255,136,0.45);text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;font-family:Courier New,monospace}' +
    '.val{font-family:Courier New,monospace;font-weight:700;letter-spacing:-0.5px}' +
    '.scan-line{position:fixed;left:0;right:0;height:1px;background:linear-gradient(transparent,rgba(0,255,136,0.4),transparent);animation:scan 6s linear infinite;pointer-events:none;z-index:9999}' +
    '</style></head><body>' +
    '<div class="scan-line"></div>' +

    // Header
    '<div class="f" style="margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-start">' +
      '<div>' +
        '<div style="font-size:10px;color:rgba(0,255,136,0.4);font-family:Courier New,monospace;letter-spacing:3px;margin-bottom:4px">// CLASSIFIED INTEL</div>' +
        '<div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#fff">TRIAD <span style="color:var(--g)">WAITLIST</span></div>' +
        '<div style="font-size:10px;color:rgba(0,255,136,0.4);font-family:Courier New,monospace;margin-top:3px">' +
          '<span style="color:var(--g);animation:pulse 1.5s infinite;display:inline-block">&#9632;</span> LIVE &nbsp;|&nbsp; ' + ts + ' &nbsp;|&nbsp; ' +
          countryCount + ' COUNTRIES DETECTED' +
        '</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        '<div style="font-size:9px;color:rgba(0,255,136,0.3);font-family:Courier New,monospace">SYS STATUS</div>' +
        '<div style="font-size:11px;color:var(--g);font-family:Courier New,monospace">OPERATIONAL<span style="animation:blink 1s infinite">_</span></div>' +
      '</div>' +
    '</div>' +

    // Total
    '<div class="f hc" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;padding:20px 24px;border-color:rgba(0,255,136,0.35);animation-delay:0.05s">' +
      '<div>' +
        '<div class="lbl">TOTAL ENROLLED</div>' +
        '<div class="val" style="font-size:64px;color:var(--g);letter-spacing:-3px;line-height:1;animation:glow 3s ease-in-out infinite">' + total + '</div>' +
        '<div style="font-size:11px;color:rgba(0,255,136,0.4);font-family:Courier New,monospace;margin-top:4px">SUBJECTS ON WAITLIST</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        '<div style="font-size:9px;color:rgba(0,255,136,0.3);font-family:Courier New,monospace;margin-bottom:4px">GROWTH INDEX</div>' +
        '<div style="font-size:28px;font-weight:800;color:' + growthColor + ';font-family:Courier New,monospace">' + growthLabel + '</div>' +
        '<div style="font-size:9px;color:rgba(0,255,136,0.3);font-family:Courier New,monospace;margin-top:2px">VS YESTERDAY</div>' +
      '</div>' +
    '</div>' +

    // 3-col stats
    '<div class="f" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px;animation-delay:0.1s">' +
      '<div class="hc">' +
        '<div class="lbl">TODAY</div>' +
        '<div class="val" style="font-size:32px;color:#fff">' + today + '</div>' +
        '<div style="font-size:9px;color:var(--c);font-family:Courier New,monospace;margin-top:3px">T+0 HRS</div>' +
      '</div>' +
      '<div class="hc">' +
        '<div class="lbl">YESTERDAY</div>' +
        '<div class="val" style="font-size:32px;color:#fff">' + yesterday + '</div>' +
        '<div style="font-size:9px;color:rgba(0,212,255,0.5);font-family:Courier New,monospace;margin-top:3px">T-24 HRS</div>' +
      '</div>' +
      '<div class="hc">' +
        '<div class="lbl">7-DAY OPS</div>' +
        '<div class="val" style="font-size:32px;color:#fff">' + last7 + '</div>' +
        '<div style="font-size:9px;color:rgba(0,212,255,0.5);font-family:Courier New,monospace;margin-top:3px">ROLLING WEEK</div>' +
      '</div>' +
    '</div>' +

    // Bar chart
    '<div class="f hc" style="margin-bottom:12px;animation-delay:0.15s">' +
      '<div class="lbl">SIGNAL ACTIVITY // 7-DAY WAVE</div>' +
      '<svg viewBox="0 0 700 100" width="100%" style="overflow:visible;margin-top:4px">' +
        '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#00ff88"/><stop offset="100%" stop-color="#00d4ff"/></linearGradient></defs>' +
        bars +
      '</svg>' +
    '</div>' +

    // World map
    '<div class="f hc" style="margin-bottom:12px;animation-delay:0.2s">' +
      '<div class="lbl">GLOBAL REACH // SIGNAL ORIGIN MAP</div>' +
      '<div style="position:relative;background:#000e06;border-radius:4px;overflow:hidden;margin-top:8px;margin-bottom:16px">' +
        '<svg viewBox="0 0 1000 500" width="100%" style="display:block;opacity:0.95">' +
          gridLines +
          mapDots +
          // Corner labels
          '<text x="8" y="14" fill="rgba(0,255,136,0.25)" style="font-size:10px;font-family:Courier New">180W</text>' +
          '<text x="470" y="14" fill="rgba(0,255,136,0.25)" style="font-size:10px;font-family:Courier New">0</text>' +
          '<text x="964" y="14" fill="rgba(0,255,136,0.25)" style="font-size:10px;font-family:Courier New">180E</text>' +
          '<text x="8" y="258" fill="rgba(0,255,136,0.3)" style="font-size:10px;font-family:Courier New">EQ</text>' +
        '</svg>' +
      '</div>' +
      (countryRows || '<div style="font-size:12px;color:rgba(0,255,136,0.3);font-family:Courier New,monospace;padding:8px 0">NO LOCATION DATA YET. DATA WILL APPEAR WITH NEW SIGNUPS.</div>') +
    '</div>' +

    // Sources
    '<div class="f hc" style="animation-delay:0.25s">' +
      '<div class="lbl">SOURCE INTEL // ACQUISITION CHANNELS</div>' +
      '<div style="margin-top:12px">' +
        (sourceRows || '<div style="font-size:12px;color:rgba(0,255,136,0.3);font-family:Courier New,monospace">NO SOURCE DATA DETECTED.</div>') +
      '</div>' +
    '</div>' +

    '<div style="margin-top:20px;font-size:9px;color:rgba(0,255,136,0.2);text-align:center;font-family:Courier New,monospace;letter-spacing:2px">// TRIAD SYSTEMS - RESTRICTED ACCESS - INTERNAL USE ONLY //</div>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html).setTitle('TRIAD // INTEL');
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
